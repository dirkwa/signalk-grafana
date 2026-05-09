import { chmodSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { Config } from "./config/schema";

export function resolveSignalkHost(config: Config): string {
  return (
    config.signalkUrl?.replace(/^https?:\/\//, "") ||
    `host.containers.internal:${process.env.PORT || 3000}`
  );
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

  const skHost = resolveSignalkHost(config);
  const signalkYaml = `apiVersion: 1
datasources:
  - name: Signal K
    uid: signalk
    type: tkurki-signalk-datasource
    access: proxy
    url: http://${skHost}
    editable: true
    jsonData:
      context: self
      hostname: ${skHost}
      ssl: false
`;

  writeFileSync(join(dsDir, "signalk.yaml"), signalkYaml);
}
