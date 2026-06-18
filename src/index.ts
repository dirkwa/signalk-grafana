import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "fs";
import { join } from "node:path";
import path from "node:path";
import { IRouter } from "express";
import { Config, ConfigSchema } from "./config/schema";
import {
  generateProvisioning,
  resolveSignalkEndpoint,
  SignalkEndpoint,
} from "./provisioning";
import { probeResultToEndpoint, probeSignalkEndpoint } from "./signalk-probe";
import {
  handleDashboardFile,
  handleDashboardManifest,
  handleDbExport,
  handleProvisioningFile,
  handleProvisioningManifest,
} from "./full-export";
import { rehydrateFromBackup } from "./rehydrate";
import {
  awaitApproval,
  beginTokenRequest,
  readCachedToken,
  SignalkBase,
  writeCachedToken,
} from "./signalk-token";

const PLUGIN_ID = "signalk-grafana";
const CONTAINER_NAME = "signalk-grafana";

interface App {
  debug: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  setPluginStatus: (msg: string) => void;
  setPluginError: (msg: string) => void;
  getDataDirPath: () => string;
  savePluginOptions?: (
    options: object,
    cb: (err: NodeJS.ErrnoException | null) => void,
  ) => void;
  [key: string]: unknown;
}

interface ContainerManagerApi {
  getRuntime: () => { runtime: string; version: string } | null;
  ensureRunning: (name: string, config: unknown) => Promise<void>;
  pullImage: (
    image: string,
    onProgress?: (msg: string) => void,
  ) => Promise<void>;
  start: (name: string) => Promise<void>;
  stop: (name: string) => Promise<void>;
  remove: (name: string) => Promise<void>;
  getState: (name: string) => Promise<string>;
  execInContainer: (
    name: string,
    command: string[],
  ) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
  ensureNetwork: (name: string) => Promise<void>;
  connectToNetwork: (
    containerName: string,
    networkName: string,
  ) => Promise<void>;
  // WHY: optional to support older signalk-container versions without this method.
  resolveHostPath?: (
    absPath: string,
  ) => Promise<{ source: string; subPath: string } | null>;
  // WHY: doctor surface exists from signalk-container 1.4+; mirror only the fields we read.
  doctor?: {
    selfDeployment: () => Promise<{ isContainerized: boolean }>;
  };
}

// WHY: returns false on any failure so we don't accidentally skip the permission fix on bare-metal SK when the doctor surface is missing or throws.
async function isContainerizedSignalK(
  containers: ContainerManagerApi,
): Promise<boolean> {
  if (!containers.doctor) return false;
  try {
    const result = await containers.doctor.selfDeployment();
    return result.isContainerized === true;
  } catch {
    return false;
  }
}

// WHY: in-container SK needs signalk-container to translate the plugin path to a host-visible bind source; fall back to the in-container path on any failure so bare-metal and older signalk-container keep working.
async function resolveVolumeSource(
  containers: ContainerManagerApi | undefined,
  absPath: string,
): Promise<string> {
  if (!containers || typeof containers.resolveHostPath !== "function")
    return absPath;
  try {
    const resolved = await containers.resolveHostPath(absPath);
    // WHY: join source + subPath to handle parent-directory mounts (subPath is "" for exact-match mounts).
    return resolved ? path.join(resolved.source, resolved.subPath) : absPath;
  } catch {
    return absPath;
  }
}

const ENDPOINT_SIDECAR = "signalk-endpoint";

function readLastGoodEndpoint(dataDir: string): SignalkEndpoint | undefined {
  try {
    const raw = readFileSync(join(dataDir, ENDPOINT_SIDECAR), "utf8");
    const parsed = JSON.parse(raw) as Partial<SignalkEndpoint>;
    if (
      typeof parsed.host === "string" &&
      typeof parsed.ssl === "boolean" &&
      typeof parsed.tlsSkipVerify === "boolean"
    ) {
      return parsed as SignalkEndpoint;
    }
  } catch {
    // no/invalid sidecar — caller falls back to the legacy default
  }
  return undefined;
}

function writeLastGoodEndpoint(
  dataDir: string,
  endpoint: SignalkEndpoint,
): void {
  try {
    writeFileSync(join(dataDir, ENDPOINT_SIDECAR), JSON.stringify(endpoint));
  } catch {
    // best-effort cache; a failed write just means a re-probe next start
  }
}

// Derive the loopback base (scheme/port) the token client should use from the
// resolved datasource endpoint. Falls back to plain http on process.env.PORT
// when no endpoint resolved (unsecured/legacy path).
function signalkBaseFromEndpoint(
  endpoint: SignalkEndpoint | null,
): SignalkBase {
  if (endpoint) {
    const portStr = endpoint.host.split(":")[1];
    const port = Number(portStr) || (endpoint.ssl ? 443 : 80);
    return {
      scheme: endpoint.ssl ? "https" : "http",
      port,
      tlsSkipVerify: endpoint.tlsSkipVerify,
    };
  }
  return {
    scheme: "http",
    port: Number(process.env.PORT) || 3000,
    tlsSkipVerify: false,
  };
}

interface RecreateInputs {
  tag: string;
  ports: Record<string, string>;
  env: Record<string, string>;
  networkMode: string;
}

function computeConfigHash(inputs: RecreateInputs, dataDir: string): string {
  // Hash every datasource YAML so a change to any of them (questdb or signalk)
  // forces a recreate — Grafana reads provisioning only at boot.
  const readDatasourceYaml = (name: string): string => {
    try {
      return readFileSync(
        join(dataDir, "provisioning", "datasources", name),
        "utf8",
      );
    } catch {
      return "";
    }
  };
  const provisioningHash = createHash("sha256")
    .update(readDatasourceYaml("questdb.yaml"))
    .update("\0")
    .update(readDatasourceYaml("signalk.yaml"))
    .digest("hex");
  return JSON.stringify({
    tag: inputs.tag,
    ports: inputs.ports,
    env: inputs.env,
    networkMode: inputs.networkMode,
    provisioningHash,
  });
}

module.exports = (app: App) => {
  let currentConfig: Config | null = null;
  // Set true on stop() so any in-flight token poller exits its loop.
  let tokenPollerCancelled = false;
  // WHY: token-approval reprovisioning must reuse the startup endpoint.
  let sessionEndpoint: SignalkEndpoint | null = null;

  async function asyncStart(config: Config) {
    currentConfig = config;
    tokenPollerCancelled = false;
    const dataDir = app.getDataDirPath();

    let containers: ContainerManagerApi | undefined;
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      containers = (globalThis as any).__signalk_containerManager as
        | ContainerManagerApi
        | undefined;
      if (containers && containers.getRuntime()) break;
      app.setPluginStatus("Waiting for container runtime...");
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    if (!containers || !containers.getRuntime()) {
      app.setPluginError(
        "signalk-container plugin required. Install it and ensure a container runtime is available.",
      );
      return;
    }

    app.setPluginStatus("Ensuring container network...");
    await containers.ensureNetwork(config.networkName);

    // Must run before Grafana starts: container opens grafana.db on boot.
    // Any later restore-into-place wouldn't be seen until the next recreate.
    try {
      await rehydrateFromBackup({ dataDir, log: (msg) => app.debug(msg) });
    } catch (err) {
      app.error(
        `Rehydrate from backup failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    app.setPluginStatus("Detecting Signal K server connection...");
    // WHY: in-process 127.0.0.1 probe learns the server's real scheme/port/cert;
    // signalkUrl overrides it; inconclusive reuses last-good (never downgrades).
    if (config.signalkUrl) {
      sessionEndpoint = resolveSignalkEndpoint(config);
    } else {
      const result = await probeSignalkEndpoint({
        httpPort: Number(process.env.PORT) || 3000,
        dataDir,
        log: (msg) => app.debug(msg),
      });
      sessionEndpoint = probeResultToEndpoint(
        result,
        readLastGoodEndpoint(dataDir),
      );
      app.debug(
        `Signal K endpoint: ${sessionEndpoint.ssl ? "https" : "http"}://${sessionEndpoint.host}` +
          ` (tlsSkipVerify=${sessionEndpoint.tlsSkipVerify}, conclusive=${result.conclusive})`,
      );
      if (!result.conclusive && result.scheme === "https") {
        app.setPluginStatus(
          "Detected an https Signal K server but could not confirm a reachable " +
            "port. If the Grafana datasource is unreachable, set the plugin's " +
            "Signal K server URL override (e.g. https://192.168.0.122:443).",
        );
      }
    }
    if (sessionEndpoint.ssl) writeLastGoodEndpoint(dataDir, sessionEndpoint);

    app.setPluginStatus("Generating Grafana provisioning...");
    // If a token from a prior session is cached, thread it into the
    // initial provisioning so the datasource has auth from the very
    // first container start. New installs on secured SK fall back to
    // the background request flow below.
    const initialToken = readCachedToken(dataDir);
    generateProvisioning(dataDir, config, initialToken, sessionEndpoint);

    // Fix permissions on grafana-data from previous runs with different UID mappings.
    // podman unshare enters the user namespace where the mapped UIDs are accessible.
    // WHY skip when SK is containerized: (1) the dataDir is the in-container path which
    // podman on the host can't reach anyway, and (2) the SK container's bundled podman
    // client talks to the host daemon over a Unix socket; `podman unshare` is not
    // supported by the remote client and writes a "cannot use command 'podman unshare'
    // with the remote podman client" line to stderr before failing.
    const runtime = containers.getRuntime();
    const skContainerized = await isContainerizedSignalK(containers);
    if (runtime && runtime.runtime === "podman" && !skContainerized) {
      try {
        const { execFileSync } = await import("child_process");
        // stdio 'ignore' silences any unshare-not-supported messages on stderr.
        execFileSync(
          "podman",
          ["unshare", "chmod", "-R", "a+rwX", `${dataDir}/grafana-data`],
          { timeout: 15000, stdio: "ignore" },
        );
      } catch {
        app.debug("could not fix grafana-data permissions via podman unshare");
      }
    }

    const containerConfig = await buildContainerConfig(
      containers,
      dataDir,
      config,
    );

    // WHY YAML in the hash: a scheme/port/tlsSkipVerify change rewrites only the
    // YAML (not env/ports), and Grafana reads provisioning solely at boot.
    const configHash = computeConfigHash(containerConfig, dataDir);
    const hashFile = `${dataDir}.container-hash`;
    let lastHash = "";
    try {
      lastHash = readFileSync(hashFile, "utf8");
    } catch {
      // first run
    }

    const state = await containers.getState("signalk-grafana");
    if (state !== "missing" && configHash !== lastHash) {
      app.setPluginStatus("Recreating Grafana container (config changed)...");
      await containers.remove("signalk-grafana");
    }

    app.setPluginStatus("Starting Grafana container...");
    await containers.ensureRunning("signalk-grafana", containerConfig);

    writeFileSync(hashFile, configHash);

    const grafanaUrl = `http://127.0.0.1:${config.grafanaPort}`;
    const healthDeadline = Date.now() + 30000;
    while (Date.now() < healthDeadline) {
      try {
        const res = await fetch(`${grafanaUrl}/api/health`, {
          signal: AbortSignal.timeout(2000),
        });
        if (res.ok) break;
      } catch {
        // not ready yet
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    // Always set the admin password after startup to ensure it matches config
    try {
      await containers.execInContainer("signalk-grafana", [
        "grafana",
        "cli",
        "admin",
        "reset-admin-password",
        config.adminPassword ?? "admin",
      ]);
    } catch {
      app.debug("could not set admin password");
    }

    app.setPluginStatus(`Grafana running at port ${config.grafanaPort}`);

    // Background: if SK security is enabled and we don't already have a
    // cached token, drive the device-access-request flow. On approval,
    // rewrite the datasource provisioning YAML with the JWT and
    // explicitly recreate the grafana container so it re-reads
    // provisioning at boot. Default-true when the field is absent so
    // first-install (Signal K does not seed schema defaults into the
    // runtime config object) still kicks off the flow.
    const wantsToken = config.requestSignalkToken !== false;
    if (wantsToken && initialToken === undefined) {
      void ensureSignalkToken(containers, dataDir, config).catch((err) => {
        app.debug(
          `Signal K token flow failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }
  }

  async function ensureSignalkToken(
    containers: ContainerManagerApi,
    dataDir: string,
    config: Config,
  ): Promise<void> {
    // Reach SK over the scheme/port the startup probe resolved. On a TLS
    // server, hitting the plain http port instead would 302 to https and the
    // self-signed loopback cert would abort the request, leaving no token.
    const base = signalkBaseFromEndpoint(sessionEndpoint);
    // Permissions: ask for readwrite up front. Today the datasource only
    // reads paths/history, but a future Grafana-alerting → SK-notification
    // path would need write — and SK admin UI cannot widen permissions
    // post-approval, only revoke + re-request. One ask now beats a
    // migration later. Same reasoning as mayara-server-signalk-plugin.
    const begin = await beginTokenRequest({
      dataDir,
      base,
      clientId: PLUGIN_ID,
      description:
        "Signal K Grafana plugin — datasource auth for Explore and dashboards",
      permissions: "readwrite",
    });

    switch (begin.kind) {
      case "cached":
        // Race: token landed between the initial readCachedToken and
        // the POST. Re-provision + recreate so the container picks it up.
        await applyToken(containers, dataDir, config, begin.token);
        return;
      case "no-security":
        app.debug(
          "Signal K security disabled; datasource will run without auth",
        );
        return;
      case "requests-disabled":
        app.setPluginStatus(
          "Signal K device access requests are disabled. Enable them in " +
            "Security → Access Requests, or paste a token into the Grafana " +
            "Signal K datasource manually.",
        );
        return;
      case "error":
        app.debug(`Signal K token request error: ${begin.message}`);
        return;
      case "pending":
        break;
    }

    app.setPluginStatus(
      "Awaiting Signal K token approval — see Security → Access Requests",
    );
    app.debug(
      `Awaiting approval at ${begin.href} (request ${begin.requestId}). ` +
        `Set plugin config "requestSignalkToken" to false to suppress this.`,
    );

    const token = await awaitApproval(
      begin.href,
      base,
      () => tokenPollerCancelled,
      (msg) => app.debug(msg),
    );
    if (!token) {
      if (!tokenPollerCancelled) {
        app.setPluginStatus(
          "Signal K token request was denied or expired. Dashboards on a " +
            "secured server will not see paths until you restart the plugin " +
            "to request again.",
        );
      }
      return;
    }

    writeCachedToken(dataDir, token);
    app.debug(
      "Signal K token approved and cached; recreating Grafana container with auth",
    );
    app.setPluginStatus(
      "Signal K token approved — recreating Grafana container...",
    );
    try {
      await applyToken(containers, dataDir, config, token);
      app.setPluginStatus(`Grafana running at port ${config.grafanaPort}`);
    } catch (err) {
      app.setPluginError(
        `Token approved but Grafana recreate failed: ${err instanceof Error ? err.message : String(err)}. ` +
          "Restart the plugin to retry.",
      );
    }
  }

  // Re-provision the datasource YAML with `token` and force a container
  // recreate. Grafana only reads provisioning at startup, and
  // signalk-container's drift detection diffs the bind-mount path (which
  // didn't change), not the file contents — so a plain ensureRunning
  // would not pick the new YAML up. Explicit remove + ensureRunning is
  // the only way to get the secret into the running grafana instance.
  async function applyToken(
    containers: ContainerManagerApi,
    dataDir: string,
    config: Config,
    token: string,
  ): Promise<void> {
    // Reuse the endpoint resolved at start so the auth recreate can't silently
    // revert a probed https/tlsSkipVerify connection back to the http default.
    const endpoint =
      sessionEndpoint ??
      (config.signalkUrl ? resolveSignalkEndpoint(config) : undefined);
    generateProvisioning(dataDir, config, token, endpoint);
    await containers.remove(CONTAINER_NAME);
    const containerConfig = await buildContainerConfig(
      containers,
      dataDir,
      config,
    );
    await containers.ensureRunning(CONTAINER_NAME, containerConfig);
    // Keep the recreate hash in step with the just-written YAML so the next
    // asyncStart doesn't see a stale hash and recreate a second time.
    writeFileSync(
      `${dataDir}.container-hash`,
      computeConfigHash(containerConfig, dataDir),
    );
  }

  // WHY: app.getDataDirPath() is SK-container-internal when SK runs in a
  // container; the runtime daemon needs the host source. Shared between
  // the initial start path and the post-token-approval recreate so the
  // two paths can't diverge silently.
  async function buildContainerConfig(
    containers: ContainerManagerApi,
    dataDir: string,
    config: Config,
  ) {
    const bind = config.bindToAllInterfaces ? "0.0.0.0" : "127.0.0.1";
    const provisioningSrc = await resolveVolumeSource(
      containers,
      `${dataDir}/provisioning`,
    );
    const grafanaDataSrc = await resolveVolumeSource(
      containers,
      `${dataDir}/grafana-data`,
    );
    return {
      image: "grafana/grafana",
      tag: config.grafanaVersion ?? "latest",
      ports: {
        "3000/tcp": `${bind}:${config.grafanaPort}`,
      },
      networkMode: config.networkName,
      volumes: {
        "/etc/grafana/provisioning": provisioningSrc,
        "/var/lib/grafana": grafanaDataSrc,
      },
      env: {
        GF_SECURITY_ADMIN_PASSWORD: config.adminPassword ?? "admin",
        GF_AUTH_ANONYMOUS_ENABLED: String(config.anonymousAccess ?? true),
        GF_AUTH_ANONYMOUS_ORG_ROLE: "Viewer",
        GF_FEATURE_TOGGLES_DISABLE: "backgroundPluginInstaller",
        GF_INSTALL_PLUGINS: "tkurki-signalk-datasource",
        GF_SECURITY_ALLOW_EMBEDDING: "true",
        ...(config.subPath
          ? {
              GF_SERVER_ROOT_URL: `%(protocol)s://%(domain)s:%(http_port)s${config.subPath}`,
              GF_SERVER_SERVE_FROM_SUB_PATH: "true",
            }
          : {}),
      },
      restart: "unless-stopped",
    };
  }

  const plugin = {
    id: "signalk-grafana",
    name: "Grafana Dashboards",

    schema: ConfigSchema,

    start(config: Config) {
      asyncStart(config).catch((err) => {
        app.setPluginError(
          `Startup failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    },

    async stop() {
      // Break any in-flight token-approval poller before tearing down so
      // it doesn't outlive the plugin and write a stale token after stop().
      tokenPollerCancelled = true;
      if (currentConfig) {
        const containers = (globalThis as any).__signalk_containerManager as
          | ContainerManagerApi
          | undefined;
        if (containers) {
          try {
            await containers.stop("signalk-grafana");
          } catch {
            // may already be stopped
          }
        }
      }
      currentConfig = null;
      sessionEndpoint = null;
    },

    registerWithRouter(router: IRouter) {
      router.get("/api/status", async (_req, res) => {
        try {
          if (!currentConfig) {
            res.status(503).json({ status: "not_running" });
            return;
          }
          const grafanaUrl = `http://127.0.0.1:${currentConfig.grafanaPort}`;
          const healthRes = await fetch(`${grafanaUrl}/api/health`, {
            signal: AbortSignal.timeout(3000),
          });
          if (!healthRes.ok) {
            res.status(503).json({ status: "unhealthy" });
            return;
          }
          const health = (await healthRes.json()) as { version?: string };

          // Probe the Signal K datasource via the Grafana proxy. The tkurki
          // plugin is frontend-only so /api/datasources/.../health always
          // returns plugin.unavailable; the proxy is what panels actually
          // use, so a 200 on /signalk is the truthful reachability signal.
          // The datasource UID is auto-generated by Grafana when created
          // via the API, so we resolve it by name first.
          let signalk: {
            reachable: boolean;
            url?: string;
            version?: string;
            error?: string;
          } = { reachable: false };
          // WHY no auth below: authenticating this 5s poll with a stale
          // password tripped Grafana's brute-force lockout; the anonymous
          // Viewer reads the datasource instead, so probing needs anonymous
          // access on (the default) and is skipped when it is off.
          if (currentConfig.anonymousAccess === false) {
            signalk = {
              reachable: false,
              error: "Anonymous access disabled; cannot probe datasource",
            };
          } else {
            try {
              const dsRes = await fetch(
                `${grafanaUrl}/api/datasources/name/Signal%20K`,
                {
                  signal: AbortSignal.timeout(3000),
                },
              );
              if (!dsRes.ok) {
                signalk = {
                  reachable: false,
                  error:
                    dsRes.status === 404
                      ? "Datasource not provisioned"
                      : `HTTP ${dsRes.status}`,
                };
              } else {
                const ds = (await dsRes.json()) as { uid?: string };
                if (!ds.uid) {
                  signalk = {
                    reachable: false,
                    error: "Datasource has no uid",
                  };
                } else {
                  const skRes = await fetch(
                    `${grafanaUrl}/api/datasources/proxy/uid/${encodeURIComponent(ds.uid)}/signalk`,
                    {
                      signal: AbortSignal.timeout(3000),
                    },
                  );
                  if (skRes.ok) {
                    const disc = (await skRes.json()) as {
                      server?: { version?: string };
                      endpoints?: { v1?: { "signalk-http"?: string } };
                    };
                    const proxiedUrl = disc.endpoints?.v1?.["signalk-http"];
                    signalk = {
                      reachable: true,
                      version: disc.server?.version,
                      url: proxiedUrl?.replace(/\/signalk\/v1\/api\/?$/, ""),
                    };
                  } else {
                    signalk = {
                      reachable: false,
                      error: `HTTP ${skRes.status}`,
                    };
                  }
                }
              }
            } catch (err) {
              signalk = {
                reachable: false,
                error: err instanceof Error ? err.message : String(err),
              };
            }
          }

          res.json({
            status: "running",
            port: currentConfig.grafanaPort,
            version: health.version || "unknown",
            signalk,
          });
        } catch {
          res.status(503).json({ status: "not_running" });
        }
      });

      router.get("/api/versions", async (_req, res) => {
        try {
          const ghRes = await fetch(
            "https://api.github.com/repos/grafana/grafana/releases?per_page=10",
            {
              headers: { Accept: "application/vnd.github+json" },
              signal: AbortSignal.timeout(10000),
            },
          );
          if (!ghRes.ok) {
            res.status(502).json({ error: "Failed to fetch releases" });
            return;
          }
          const releases = (await ghRes.json()) as {
            tag_name: string;
            prerelease: boolean;
            draft: boolean;
          }[];
          const versions = releases
            .filter((r) => !r.draft)
            .map((r) => ({
              tag: r.tag_name.replace(/^v/, ""),
              prerelease: r.prerelease,
            }));
          res.json(versions);
        } catch (err) {
          res.status(500).json({
            error: err instanceof Error ? err.message : "Unknown error",
          });
        }
      });

      router.get("/api/update/check", async (_req, res) => {
        try {
          if (!currentConfig) {
            res.status(503).json({ error: "Plugin not running" });
            return;
          }

          const grafanaUrl = `http://127.0.0.1:${currentConfig.grafanaPort}`;
          let currentVersion = "unknown";
          try {
            const healthRes = await fetch(`${grafanaUrl}/api/health`, {
              signal: AbortSignal.timeout(3000),
            });
            if (healthRes.ok) {
              const health = (await healthRes.json()) as {
                version?: string;
              };
              currentVersion = health.version || "unknown";
            }
          } catch {
            // not reachable
          }

          const ghRes = await fetch(
            "https://api.github.com/repos/grafana/grafana/releases?per_page=5",
            {
              headers: { Accept: "application/vnd.github+json" },
              signal: AbortSignal.timeout(10000),
            },
          );
          let latestVersion = "unknown";
          if (ghRes.ok) {
            const releases = (await ghRes.json()) as {
              tag_name: string;
              prerelease: boolean;
              draft: boolean;
            }[];
            const stable = releases.find((r) => !r.draft && !r.prerelease);
            if (stable) latestVersion = stable.tag_name.replace(/^v/, "");
          }

          const isNewerAvailable = (
            current: string,
            latest: string,
          ): boolean => {
            const pc = current.split(".").map((s) => parseInt(s, 10) || 0);
            const pl = latest.split(".").map((s) => parseInt(s, 10) || 0);
            for (let i = 0; i < Math.max(pc.length, pl.length); i++) {
              const vc = pc[i] ?? 0;
              const vl = pl[i] ?? 0;
              if (vl > vc) return true;
              if (vl < vc) return false;
            }
            return false;
          };

          const updateAvailable =
            currentVersion !== "unknown" &&
            latestVersion !== "unknown" &&
            isNewerAvailable(currentVersion, latestVersion);

          res.json({ currentVersion, latestVersion, updateAvailable });
        } catch (err) {
          res.status(500).json({
            error: err instanceof Error ? err.message : "Unknown error",
          });
        }
      });

      router.post("/api/update/apply", async (_req, res) => {
        try {
          const containers = (globalThis as any).__signalk_containerManager as
            | ContainerManagerApi
            | undefined;
          if (!containers || !containers.getRuntime()) {
            res.status(503).json({ error: "Container manager not available" });
            return;
          }

          const ghRes = await fetch(
            "https://api.github.com/repos/grafana/grafana/releases?per_page=5",
            {
              headers: { Accept: "application/vnd.github+json" },
              signal: AbortSignal.timeout(10000),
            },
          );
          if (!ghRes.ok) {
            res.status(502).json({ error: "Failed to fetch releases" });
            return;
          }
          const releases = (await ghRes.json()) as {
            tag_name: string;
            prerelease: boolean;
            draft: boolean;
          }[];
          const stable = releases.find((r) => !r.draft && !r.prerelease);
          if (!stable) {
            res.status(404).json({ error: "No stable release found" });
            return;
          }
          const newTag = stable.tag_name.replace(/^v/, "");

          app.setPluginStatus(`Pulling Grafana ${newTag}...`);
          await containers.pullImage(`grafana/grafana:${newTag}`);

          app.setPluginStatus("Replacing container...");
          await containers.remove("signalk-grafana");

          app.setPluginStatus(`Starting Grafana ${newTag}...`);
          // WHY: app.getDataDirPath() is SK-container-internal when SK runs in a container; the runtime daemon needs the host source.
          const provisioningSrc = await resolveVolumeSource(
            containers,
            `${app.getDataDirPath()}/provisioning`,
          );
          const grafanaDataSrc = await resolveVolumeSource(
            containers,
            `${app.getDataDirPath()}/grafana-data`,
          );
          await containers.ensureRunning("signalk-grafana", {
            image: "grafana/grafana",
            tag: newTag,
            ports: {
              "3000/tcp": `${currentConfig?.bindToAllInterfaces ? "0.0.0.0" : "127.0.0.1"}:${currentConfig?.grafanaPort ?? 3001}`,
            },
            networkMode: currentConfig?.networkName ?? "sk-network",
            volumes: {
              "/etc/grafana/provisioning": provisioningSrc,
              "/var/lib/grafana": grafanaDataSrc,
            },
            env: {
              GF_SECURITY_ADMIN_PASSWORD:
                currentConfig?.adminPassword ?? "admin",
              GF_AUTH_ANONYMOUS_ENABLED: String(
                currentConfig?.anonymousAccess ?? true,
              ),
              GF_AUTH_ANONYMOUS_ORG_ROLE: "Viewer",
              GF_FEATURE_TOGGLES_DISABLE: "backgroundPluginInstaller",
              GF_INSTALL_PLUGINS: "tkurki-signalk-datasource",
              GF_SECURITY_ALLOW_EMBEDDING: "true",
              ...(currentConfig?.subPath
                ? {
                    GF_SERVER_ROOT_URL: `%(protocol)s://%(domain)s:%(http_port)s${currentConfig.subPath}`,
                    GF_SERVER_SERVE_FROM_SUB_PATH: "true",
                  }
                : {}),
            },
            restart: "unless-stopped",
          });

          if (currentConfig) {
            currentConfig.grafanaVersion = newTag;
          }

          app.setPluginStatus(
            `Grafana ${newTag} running at port ${currentConfig?.grafanaPort ?? 3001}`,
          );
          res.json({
            status: "updated",
            newVersion: newTag,
            message: `Updated to Grafana ${newTag}. Container running.`,
          });
        } catch (err) {
          res.status(500).json({
            error: err instanceof Error ? err.message : "Unknown error",
          });
        }
      });

      // Full-export endpoints used by signalk-backup to pull a
      // consistent snapshot of Grafana state for inclusion in its
      // kopia snapshot. See src/full-export.ts. The SQLite checkpoint
      // runs in-process via node:sqlite against the bind-mounted
      // grafana.db, so no container exec is required.
      const exportDeps = () => ({
        dataDir: app.getDataDirPath(),
        log: (msg: string) => {
          app.debug(`full-export: ${msg}`);
        },
      });

      router.get("/api/full-export/db", async (req, res) => {
        await handleDbExport(req, res, exportDeps());
      });

      router.get("/api/full-export/dashboards", async (req, res) => {
        await handleDashboardManifest(req, res, exportDeps());
      });

      router.get("/api/full-export/dashboards/:name", async (req, res) => {
        await handleDashboardFile(req, res, exportDeps());
      });

      router.get("/api/full-export/provisioning", async (req, res) => {
        await handleProvisioningManifest(req, res, exportDeps());
      });

      router.get("/api/full-export/provisioning/:relPath", async (req, res) => {
        await handleProvisioningFile(req, res, exportDeps());
      });

      router.post("/api/set-password", async (req, res) => {
        try {
          const containers = (globalThis as any).__signalk_containerManager as
            | ContainerManagerApi
            | undefined;
          if (!containers || !containers.getRuntime()) {
            res.status(503).json({ error: "Container manager not available" });
            return;
          }

          const password = req.body?.password;
          if (
            !password ||
            typeof password !== "string" ||
            password.length === 0
          ) {
            res.status(400).json({ error: "Password is required" });
            return;
          }
          const result = await containers.execInContainer("signalk-grafana", [
            "grafana",
            "cli",
            "admin",
            "reset-admin-password",
            password,
          ]);

          if (result.exitCode !== 0) {
            res.status(500).json({
              error: result.stderr || "Failed to set password",
            });
            return;
          }

          if (!currentConfig) {
            // WHY skip persist: with no live config, a one-field save would
            // wipe every other saved option.
            res.json({
              status: "ok",
              message:
                "Admin password updated on the running container, but the plugin " +
                "config was unavailable to save it — it may revert on restart.",
            });
            return;
          }

          currentConfig.adminPassword = password;
          // WHY persist: asyncStart re-applies config.adminPassword on every
          // start, so an unsaved change reverts on the next restart/recreate.
          const savedConfig = currentConfig;
          const persisted = await new Promise<string | null>((resolve) => {
            if (typeof app.savePluginOptions !== "function") {
              resolve("savePluginOptions unavailable");
              return;
            }
            app.savePluginOptions(
              { ...savedConfig, adminPassword: password },
              (err) => resolve(err ? err.message : null),
            );
          });
          if (persisted) {
            app.error(`Failed to persist admin password: ${persisted}`);
            res.status(500).json({
              error: `Password set on the running container but could not be saved: ${persisted}. It may revert on restart.`,
            });
            return;
          }
          res.json({
            status: "ok",
            message:
              "Admin password updated. If a login still fails, wait ~5 min — " +
              "Grafana temporarily blocks logins after repeated failed attempts.",
          });
        } catch (err) {
          res.status(500).json({
            error: err instanceof Error ? err.message : "Unknown error",
          });
        }
      });
    },
  };

  return plugin;
};
