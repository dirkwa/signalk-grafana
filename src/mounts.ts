import path from "node:path";

// Where the requested directories must be visible inside the Grafana
// container. Grafana reads both locations from env-overridable defaults
// (GF_PATHS_PROVISIONING / GF_PATHS_DATA), which is what makes the
// named-volume redirect below possible at all.
export const GRAFANA_PROVISIONING_DIR = "/etc/grafana/provisioning";
export const GRAFANA_DATA_DIR = "/var/lib/grafana";

// Mount root for whole named volumes. Suffixed with the volume name so two
// distinct volumes can never collide, and deterministic so the container
// config (and its recreate hash) stays stable across restarts.
export const VOLUME_MOUNT_ROOT = "/signalk-vols";

// Result shape of signalk-container's resolveHostPath: `source` is the left
// side of a -v flag (host path or named-volume name), `subPath` the offset
// inside that mount where the requested path lives ("" when none).
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
    // Bind mount. Current signalk-container folds subPath into source for
    // binds; the join keeps older versions that reported parent-directory
    // binds with a subPath working (it is a no-op on "").
    return {
      source: path.join(r.source, r.subPath),
      mountDest: desiredDest,
      containerPath: desiredDest,
    };
  }
  if (r.subPath === "") {
    // Named volume attached exactly at the requested directory — mountable
    // as-is at the standard destination.
    return {
      source: r.source,
      mountDest: desiredDest,
      containerPath: desiredDest,
    };
  }
  // Named volume covering a parent (typically the whole SK config root).
  // Runtimes cannot uniformly subpath-mount volumes (podman < 6.1 silently
  // ignores VolumeOptions.Subpath), and "volume/sub" as a source is rejected
  // as an invalid volume name — so mount the volume whole and point Grafana
  // at the subdirectory via GF_PATHS_* instead.
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
  // Both directories normally live in the same volume, so the record
  // dedupes to a single whole-volume mount.
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

// WHY: in-container SK needs signalk-container to translate plugin paths to
// host-visible mount sources; fall back to the in-container path on any
// failure so bare-metal and older signalk-container keep working.
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
