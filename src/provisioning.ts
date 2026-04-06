import { mkdirSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { Config } from "./config/schema";

export function generateProvisioning(dataDir: string, config: Config): void {
  const provDir = join(dataDir, "provisioning");
  const dsDir = join(provDir, "datasources");
  const grafanaDataDir = join(dataDir, "grafana-data");

  mkdirSync(dsDir, { recursive: true });
  mkdirSync(grafanaDataDir, { recursive: true });

  const questdbHost = `sk-${config.questdbContainerName}`;

  const datasourceYaml = `apiVersion: 1
datasources:
  - name: QuestDB
    uid: signalk-questdb
    type: postgres
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

  writeFileSync(join(dsDir, "questdb.yaml"), datasourceYaml);

  // Remove stale SK datasource provisioning file (crashes Grafana if plugin not installed)
  try {
    unlinkSync(join(dsDir, "signalk.yaml"));
  } catch {
    // doesn't exist
  }
}
