import { mkdirSync, writeFileSync, existsSync, cpSync } from "fs";
import { join } from "path";
import { Config } from "./config/schema";

export function generateProvisioning(dataDir: string, config: Config): void {
  const provDir = join(dataDir, "provisioning");
  const dsDir = join(provDir, "datasources");
  const dbProvDir = join(provDir, "dashboards");
  const dbDir = join(dataDir, "dashboards");
  const grafanaDataDir = join(dataDir, "grafana-data");

  mkdirSync(dsDir, { recursive: true });
  mkdirSync(dbProvDir, { recursive: true });
  mkdirSync(dbDir, { recursive: true });
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

  const skHost =
    config.signalkUrl?.replace(/^https?:\/\//, "") ||
    `host.containers.internal:${process.env.PORT || 3000}`;
  const signalkDsYaml = `apiVersion: 1
datasources:
  - name: Signal K
    type: tkurki-signalk-datasource
    access: proxy
    url: http://${skHost}
    isDefault: false
    editable: true
    jsonData:
      context: self
      hostname: ${skHost}
      ssl: false
`;
  writeFileSync(join(dsDir, "signalk.yaml"), signalkDsYaml);

  const dashboardProviderYaml = `apiVersion: 1
providers:
  - name: Signal K
    orgId: 1
    folder: Signal K
    type: file
    disableDeletion: false
    editable: true
    updateIntervalSeconds: 30
    allowUiUpdates: true
    options:
      path: /var/lib/grafana/dashboards
`;

  writeFileSync(join(dbProvDir, "signalk.yaml"), dashboardProviderYaml);

  copyDashboards(dbDir);
}

function copyDashboards(destDir: string): void {
  const srcDir = join(__dirname, "dashboards");
  if (!existsSync(srcDir)) return;

  cpSync(srcDir, destDir, { recursive: true });
}
