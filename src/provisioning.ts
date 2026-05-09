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

export function generateProvisioning(dataDir: string, config: Config): void {
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
`;

  writeFileSync(join(dsDir, "signalk.yaml"), signalkYaml);
}
