import { chmodSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { Config } from "./config/schema";

export interface SignalkEndpoint {
  host: string;
  ssl: boolean;
  tlsSkipVerify: boolean;
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
    // Override path: the user opts into skipping verification explicitly, so a
    // typo'd URL fails loudly rather than silently trusting any cert.
    return {
      host: parsed.host,
      ssl: parsed.protocol === "https:",
      tlsSkipVerify: config.tlsSkipVerify === true,
    };
  }
  return {
    host: `host.containers.internal:${process.env.PORT || 3000}`,
    ssl: false,
    tlsSkipVerify: false,
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
  endpoint?: SignalkEndpoint,
): void {
  const provDir = join(dataDir, "provisioning");
  const dsDir = join(provDir, "datasources");
  const grafanaDataDir = join(dataDir, "grafana-data");

  mkdirSync(dsDir, { recursive: true });
  mkdirSync(grafanaDataDir, { recursive: true, mode: 0o777 });
  // Ensure grafana-data is world-writable so the container's grafana user (uid 472) can write
  chmodSync(grafanaDataDir, 0o777);

  const questdbHost = `sk-${config.questdbContainerName}`;

  // Two QuestDB datasources on the same PG-wire port. The official QuestDB
  // plugin is the default: Grafana's generic Postgres query builder cannot
  // list QuestDB tables (its information_schema introspection comes back
  // empty), while the QuestDB editor introspects correctly and understands
  // SAMPLE BY. The postgres-type entry stays under its original name and uid
  // so dashboards built against it keep working — renaming it would make
  // provisioning insert a second record with a colliding uid.
  // Small connection pool: QuestDB on boat hardware runs a single shared
  // worker, so a large idle pool just occupies it.
  const questdbYaml = `apiVersion: 1
datasources:
  - name: QuestDB (native)
    uid: signalk-questdb-native
    type: questdb-questdb-datasource
    access: proxy
    isDefault: true
    editable: true
    jsonData:
      server: ${questdbHost}
      port: ${config.questdbPgPort}
      username: admin
      tlsMode: disable
      maxOpenConnections: 8
      maxIdleConnections: 2
      maxConnectionLifetime: 14400
    secureJsonData:
      password: quest
  - name: QuestDB
    uid: signalk-questdb
    type: grafana-postgresql-datasource
    url: ${questdbHost}:${config.questdbPgPort}
    user: admin
    database: qdb
    access: proxy
    isDefault: false
    editable: true
    jsonData:
      sslmode: disable
      postgresVersion: 1200
    secureJsonData:
      password: quest
`;

  writeFileSync(join(dsDir, "questdb.yaml"), questdbYaml);

  // An explicit signalkUrl override always wins over a probed endpoint.
  const {
    host: skHost,
    ssl: skSsl,
    tlsSkipVerify: skTlsSkipVerify,
  } = config.signalkUrl
    ? resolveSignalkEndpoint(config)
    : (endpoint ?? resolveSignalkEndpoint(config));
  if (token !== undefined && !JWT_SHAPE.test(token)) {
    throw new Error(
      "generateProvisioning: token does not match the expected JWT shape; refusing to write",
    );
  }
  const useAuth = token !== undefined;
  // tkurki-signalk-datasource has no tlsSkipVerify field; Grafana's generic
  // datasource proxy honours jsonData.tlsSkipVerify for plugin proxy routes.
  const tlsSkipBlock = skTlsSkipVerify ? `      tlsSkipVerify: true\n` : "";
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
${tlsSkipBlock}${authBlock}`;

  writeFileSync(join(dsDir, "signalk.yaml"), signalkYaml);
}
