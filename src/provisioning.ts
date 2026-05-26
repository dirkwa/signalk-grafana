import { chmodSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { Config } from "./config/schema";

export interface SignalkEndpoint {
  host: string;
  ssl: boolean;
}

export function resolveSignalkEndpoint(config: Config): SignalkEndpoint {
  if (config.signalkUrl) {
    const raw = config.signalkUrl.includes("://")
      ? config.signalkUrl
      : `http://${config.signalkUrl}`;
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(
        `Invalid signalkUrl protocol "${parsed.protocol}". Use http:// or https://.`,
      );
    }
    return { host: parsed.host, ssl: parsed.protocol === "https:" };
  }
  return {
    host: `host.containers.internal:${process.env.PORT || 3000}`,
    ssl: false,
  };
}

// JWT shape: three base64url segments separated by dots. signalk-server's
// jwt-simple output matches this. Enforcing the shape before writing the
// provisioning YAML protects against YAML-injection if a malformed value
// ever reaches generateProvisioning.
const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export function generateProvisioning(
  dataDir: string,
  config: Config,
  token?: string,
): void {
  const provDir = join(dataDir, "provisioning");
  const dsDir = join(provDir, "datasources");
  const grafanaDataDir = join(dataDir, "grafana-data");

  mkdirSync(dsDir, { recursive: true });
  mkdirSync(grafanaDataDir, { recursive: true, mode: 0o777 });
  // Ensure grafana-data is world-writable so the container's grafana user (uid 472) can write
  chmodSync(grafanaDataDir, 0o777);

  const questdbHost = `sk-${config.questdbContainerName}`;

  const questdbYaml = `apiVersion: 1
datasources:
  - name: QuestDB
    uid: signalk-questdb
    type: grafana-postgresql-datasource
    url: ${questdbHost}:${config.questdbPgPort}
    user: admin
    database: qdb
    access: proxy
    isDefault: true
    editable: true
    jsonData:
      sslmode: disable
      postgresVersion: 1200
    secureJsonData:
      password: quest
`;

  writeFileSync(join(dsDir, "questdb.yaml"), questdbYaml);

  const { host: skHost, ssl: skSsl } = resolveSignalkEndpoint(config);
  if (token !== undefined && !JWT_SHAPE.test(token)) {
    throw new Error(
      "generateProvisioning: token does not match the expected JWT shape; refusing to write",
    );
  }
  const useAuth = token !== undefined;
  const authBlock = useAuth
    ? `    secureJsonData:\n      token: ${token}\n`
    : "";
  const signalkYaml = `apiVersion: 1
datasources:
  - name: Signal K
    uid: signalk
    type: tkurki-signalk-datasource
    access: proxy
    url: ${skSsl ? "https" : "http"}://${skHost}
    editable: true
    jsonData:
      context: self
      hostname: ${skHost}
      ssl: ${skSsl}
      useAuth: ${useAuth}
${authBlock}`;

  writeFileSync(join(dsDir, "signalk.yaml"), signalkYaml);
}
