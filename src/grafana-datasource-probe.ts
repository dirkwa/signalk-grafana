// WHY probe the Grafana proxy, not /health: the frontend-only tkurki plugin makes /api/datasources/.../health always report plugin.unavailable; the proxy is what panels actually use. Callers gate on anonymousAccess (stale-password auth trips Grafana's lockout).

export interface DatasourceProbeResult {
  reachable: boolean;
  version?: string;
  url?: string;
  error?: string;
}

// The slice of fetch the probe needs; injectable for tests.
export type FetchLike = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const PROBE_TIMEOUT_MS = 3000;

export async function probeSignalkDatasource(
  grafanaUrl: string,
  fetchFn: FetchLike = fetch,
): Promise<DatasourceProbeResult> {
  try {
    const dsRes = await fetchFn(
      `${grafanaUrl}/api/datasources/name/Signal%20K`,
      { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) },
    );
    if (!dsRes.ok) {
      return {
        reachable: false,
        error:
          dsRes.status === 404
            ? "Datasource not provisioned"
            : `HTTP ${dsRes.status}`,
      };
    }
    const ds = (await dsRes.json()) as { uid?: string };
    if (!ds.uid) {
      return { reachable: false, error: "Datasource has no uid" };
    }
    const skRes = await fetchFn(
      `${grafanaUrl}/api/datasources/proxy/uid/${encodeURIComponent(ds.uid)}/signalk`,
      { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) },
    );
    if (!skRes.ok) {
      return { reachable: false, error: `HTTP ${skRes.status}` };
    }
    const disc = (await skRes.json()) as {
      server?: { version?: string };
      endpoints?: { v1?: { "signalk-http"?: string } };
    };
    const proxiedUrl = disc.endpoints?.v1?.["signalk-http"];
    return {
      reachable: true,
      version: disc.server?.version,
      url: proxiedUrl?.replace(/\/signalk\/v1\/api\/?$/, ""),
    };
  } catch (err) {
    return {
      reachable: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
