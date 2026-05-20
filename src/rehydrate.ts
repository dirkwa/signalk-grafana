import { copyFile, mkdir, stat } from "fs/promises";
import { existsSync } from "fs";
import { dirname, join } from "path";

// signalk-backup stages exports here, and kopia's restore-with-rollback
// lays the same tree back on disk. When grafana-data/grafana.db is
// missing but a staged checkpoint exists, that's the signature of a
// fresh restore — copy the checkpoint into place before grafana starts
// so the dashboards/datasources come back to life.
const BACKUP_PLUGIN_ID = "signalk-backup";
const BACKUP_STAGING_SUBPATH = "database-exports/signalk-grafana";
const GRAFANA_DATA_SUBDIR = "grafana-data";
const GRAFANA_DB_FILENAME = "grafana.db";

export interface RehydrateDeps {
  /** signalk-grafana's data dir from app.getDataDirPath(). */
  dataDir: string;
  /** Logger; defaults to console.error when absent. */
  log?: (msg: string) => void;
}

export async function rehydrateFromBackup(
  deps: RehydrateDeps,
): Promise<boolean> {
  const log =
    deps.log ?? ((msg: string) => console.error(`[rehydrate] ${msg}`));

  const pluginConfigData = dirname(deps.dataDir);
  const stagedDb = join(
    pluginConfigData,
    BACKUP_PLUGIN_ID,
    BACKUP_STAGING_SUBPATH,
    GRAFANA_DB_FILENAME,
  );
  const liveDb = join(deps.dataDir, GRAFANA_DATA_SUBDIR, GRAFANA_DB_FILENAME);

  if (!existsSync(stagedDb)) return false;
  if (existsSync(liveDb)) return false;

  await mkdir(dirname(liveDb), { recursive: true });
  await copyFile(stagedDb, liveDb);
  const size = (await stat(liveDb)).size;
  log(`rehydrated ${liveDb} from kopia restore (${size} bytes)`);
  return true;
}
