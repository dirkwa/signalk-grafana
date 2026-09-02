import path from "node:path";

// Grafana reads both standard directories from env-overridable defaults (GF_PATHS_*), which is what makes the named-volume redirect below possible.
export const GRAFANA_PROVISIONING_DIR = "/etc/grafana/provisioning";
export const GRAFANA_DATA_DIR = "/var/lib/grafana";

// WHY per-volume subdir: distinct volumes can never collide, and the path is deterministic so the recreate hash stays stable.
export const VOLUME_MOUNT_ROOT = "/signalk-vols";

// resolveHostPath result: source is the left side of -v (host path or named-volume name), subPath the offset inside that mount ("" when none).
export interface MountResolution {
  source: string;
  subPath: string;
}

// WHY optional: older signalk-container versions don't expose resolveHostPath.
export interface HostPathResolver {
  resolveHostPath?: (absPath: string) => Promise<MountResolution | null>;
}

interface ShapedMount {
  source: string;
  mountDest: string;
  containerPath: string;
}

export interface GrafanaMounts {
  volumes: Record<string, string>;
  env: Record<string, string>;
}

function shapeOne(desiredDest: string, r: MountResolution): ShapedMount {
  if (path.isAbsolute(r.source)) {
    // WHY join: current signalk-container folds subPath into bind sources already; the join keeps older parent-bind reporting working (no-op on "").
    return {
      source: path.join(r.source, r.subPath),
      mountDest: desiredDest,
      containerPath: desiredDest,
    };
  }
  if (r.subPath === "") {
    return {
      source: r.source,
      mountDest: desiredDest,
      containerPath: desiredDest,
    };
  }
  // WHY whole-volume mount: runtimes can't uniformly subpath-mount volumes (podman < 6.1 silently ignores VolumeOptions.Subpath) and "vol/sub" is an invalid volume name — so mount the volume whole and redirect Grafana via GF_PATHS_*.
  const mountDest = `${VOLUME_MOUNT_ROOT}/${r.source}`;
  return {
    source: r.source,
    mountDest,
    containerPath: `${mountDest}/${r.subPath}`,
  };
}

export function shapeGrafanaMounts(
  provisioning: MountResolution,
  grafanaData: MountResolution,
): GrafanaMounts {
  const prov = shapeOne(GRAFANA_PROVISIONING_DIR, provisioning);
  const data = shapeOne(GRAFANA_DATA_DIR, grafanaData);
  // Both directories normally share one volume, so the record dedupes to a single whole-volume mount.
  const volumes: Record<string, string> = {
    [prov.mountDest]: prov.source,
    [data.mountDest]: data.source,
  };
  const env: Record<string, string> = {};
  if (prov.containerPath !== GRAFANA_PROVISIONING_DIR)
    env.GF_PATHS_PROVISIONING = prov.containerPath;
  if (data.containerPath !== GRAFANA_DATA_DIR)
    env.GF_PATHS_DATA = data.containerPath;
  return { volumes, env };
}

// WHY fallback: bare-metal and older signalk-container have no resolveHostPath; the in-container path is then already the host path.
export async function resolveGrafanaMounts(
  resolver: HostPathResolver | undefined,
  dataDir: string,
): Promise<GrafanaMounts> {
  const resolveOne = async (absPath: string): Promise<MountResolution> => {
    const fallback = { source: absPath, subPath: "" };
    if (!resolver || typeof resolver.resolveHostPath !== "function")
      return fallback;
    try {
      return (await resolver.resolveHostPath(absPath)) ?? fallback;
    } catch {
      return fallback;
    }
  };
  return shapeGrafanaMounts(
    await resolveOne(`${dataDir}/provisioning`),
    await resolveOne(`${dataDir}/grafana-data`),
  );
}
