import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "fs";
import { join } from "node:path";
import {
  ContainerHelperError,
  ManagedContainer,
  startSafely,
  waitForContainerManager,
} from "signalk-container-helper";
import type {
  ContainerConfig,
  ContainerManagerApi,
} from "signalk-container-helper";
import { resolveGrafanaMounts } from "./mounts.js";
import { IRouter } from "express";
import { Config, ConfigSchema } from "./config/schema.js";
import {
  generateProvisioning,
  resolveSignalkEndpoint,
  SignalkEndpoint,
} from "./provisioning.js";
import {
  probeResultToEndpoint,
  probeSignalkEndpoint,
  resolveProbeHttpPort,
} from "./signalk-probe.js";
import { probeSignalkDatasource } from "./grafana-datasource-probe.js";
import {
  handleDashboardFile,
  handleDashboardManifest,
  handleDbExport,
  handleProvisioningFile,
  handleProvisioningManifest,
} from "./full-export.js";
import { rehydrateFromBackup } from "./rehydrate.js";
import {
  awaitApproval,
  beginTokenRequest,
  readCachedToken,
  SignalkBase,
  writeCachedToken,
} from "./signalk-token.js";

const PLUGIN_ID = "signalk-grafana";
const CONTAINER_NAME = "signalk-grafana";
// Shared by start and /api/update/apply so the plugin list can't drift and drop a datasource plugin on one-click update.
const GRAFANA_PREINSTALL_PLUGINS =
  "tkurki-signalk-datasource,questdb-questdb-datasource";

interface App {
  debug: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  setPluginStatus: (msg: string) => void;
  setPluginError: (msg: string) => void;
  getDataDirPath: () => string;
  // Signal K server settings; the ports it actually listens on.
  config?: { settings?: { port?: unknown; sslport?: unknown } };
  savePluginOptions?: (
    options: object,
    cb: (err: NodeJS.ErrnoException | null) => void,
  ) => void;
  [key: string]: unknown;
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

// Hash every datasource YAML so a change to any of them (questdb or signalk) forces a recreate — Grafana reads provisioning only at boot, and signalk-container's drift detection diffs the mount path, not file contents. Tag/env/volumes/ports drift is the manager's job now.
function computeProvisioningHash(dataDir: string): string {
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
  return createHash("sha256")
    .update(readDatasourceYaml("questdb.yaml"))
    .update("\0")
    .update(readDatasourceYaml("signalk.yaml"))
    .digest("hex");
}

// WHY probe through Grafana: the in-process endpoint probe can confirm a port the Grafana container cannot reach (reverse proxy, localhost bind); only the container-side view is truthful.
async function startupStatusMessage(
  grafanaUrl: string,
  config: Config,
  log: (msg: string) => void,
): Promise<string> {
  const running = `Grafana running at port ${config.grafanaPort}`;
  // WHY skip without anonymous access: the probe rides the anonymous Viewer; authenticating with a possibly-stale password trips Grafana's lockout.
  if (config.anonymousAccess === false) return running;
  let lastError: string | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 2000));
    const probe = await probeSignalkDatasource(grafanaUrl);
    if (probe.reachable) return running;
    lastError = probe.error;
    log(`startup datasource probe attempt ${attempt + 1}: ${probe.error}`);
  }
  // WHY 404 is special: no proxy route means the datasource plugin isn't installed yet (background preinstall pending/offline) — not an endpoint problem, so don't send the user chasing ports.
  if (lastError === "HTTP 404") {
    return (
      `Grafana running at port ${config.grafanaPort}; the Signal K ` +
      "datasource plugin is still installing in the background (needs " +
      "grafana.com reachable) — dashboards work once it lands"
    );
  }
  const hint = config.signalkUrl
    ? `check the plugin's Signal K server URL override (${config.signalkUrl})`
    : "if Signal K sits behind a reverse proxy or binds to localhost only, " +
      "set the plugin's Signal K server URL override (e.g. http://<lan-ip>:80)";
  return (
    `Grafana running at port ${config.grafanaPort}, but its Signal K ` +
    `datasource cannot reach the server (${lastError ?? "unreachable"}) — ${hint}`
  );
}

export default (app: App) => {
  let currentConfig: Config | null = null;
  // Set true on stop() so any in-flight token poller exits its loop.
  let tokenPollerCancelled = false;
  // WHY: token-approval reprovisioning must reuse the startup endpoint.
  let sessionEndpoint: SignalkEndpoint | null = null;
  // WHY instance state: applyToken and the update routes go through the same ManagedContainer so every recreate is serialized against start/stop.
  let container: ManagedContainer | null = null;
  // WHY a ref: buildConfig stays sync while mounts resolve async per start.
  let currentContainerConfig: ContainerConfig | null = null;
  let panelRouter: IRouter | null = null;
  let updateRoutesRegistered = false;

  // Mounts GET/POST /api/update/{check,apply} against the ManagedContainer — serialized applies, manager-side release checking. Runs when both the router and the container exist, whichever arrives second.
  function registerUpdateRoutesOnce() {
    if (updateRoutesRegistered || !panelRouter || !container) return;
    updateRoutesRegistered = true;
    // WHY gate: the instance and its routes outlive stop(), and an apply on a disabled plugin would resurrect Grafana while nothing owns it.
    panelRouter.use("/api/update", (_req, res, next) => {
      if (!currentConfig) {
        res.status(503).json({ error: "Plugin not running" });
        return;
      }
      next();
    });
    container.registerUpdateRoutes(panelRouter, {
      onApplied: async (requestedTag) => {
        if (!currentConfig) return;
        currentConfig.grafanaVersion = requestedTag;
        // WHY persist: asyncStart rebuilds from saved options, so an unsaved tag reverts the update on the next plugin restart.
        const saved = { ...currentConfig };
        await new Promise<void>((resolve) => {
          if (typeof app.savePluginOptions !== "function") {
            app.error(
              "Failed to persist Grafana version: savePluginOptions unavailable",
            );
            resolve();
            return;
          }
          app.savePluginOptions(saved, (err) => {
            if (err)
              app.error(`Failed to persist Grafana version: ${err.message}`);
            resolve();
          });
        });
      },
    });
  }

  async function asyncStart(config: Config) {
    currentConfig = config;
    tokenPollerCancelled = false;
    const dataDir = app.getDataDirPath();

    app.setPluginStatus("Waiting for container runtime...");
    const { manager: containers, runtime: detectedRuntime } =
      await waitForContainerManager();
    if (!containers) {
      app.setPluginError(
        "signalk-container plugin required. Install it and ensure a container runtime is available.",
      );
      return;
    }
    if (!detectedRuntime) {
      app.setPluginError(
        "No container runtime detected (Podman or Docker). Install one and restart Signal K.",
      );
      return;
    }

    app.setPluginStatus("Ensuring container network...");
    await containers.ensureNetwork?.(config.networkName);

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
      const settings = app.config?.settings;
      const settingsSslport = Number(settings?.sslport);
      const result = await probeSignalkEndpoint({
        httpPort: resolveProbeHttpPort(process.env.PORT, settings?.port),
        dataDir,
        sslportHint:
          Number.isInteger(settingsSslport) && settingsSslport > 0
            ? settingsSslport
            : undefined,
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
    const skContainerized = await isContainerizedSignalK(containers);
    if (detectedRuntime.runtime === "podman" && !skContainerized) {
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

    // WHY the sidecar hash: a scheme/port/tlsSkipVerify change rewrites only the YAML, Grafana reads provisioning solely at boot, and drift detection cannot see file contents — so a YAML change must force the recreate here. Everything else (tag/env/volumes/ports) is the manager's drift detection.
    const provisioningHash = computeProvisioningHash(dataDir);
    const hashFile = `${dataDir}.container-hash`;
    let lastHash = "";
    try {
      lastHash = readFileSync(hashFile, "utf8");
    } catch {
      // first run
    }
    if (
      provisioningHash !== lastHash &&
      (await containers.getState(CONTAINER_NAME)) !== "missing"
    ) {
      app.setPluginStatus(
        "Recreating Grafana container (provisioning changed)...",
      );
      await containers.remove(CONTAINER_NAME);
    }

    currentContainerConfig = containerConfig;
    if (!container) {
      // WHY construct once: registerUpdateRoutes closes over the instance, and one instance serializes lifecycle operations across plugin restarts; buildConfig reads the ref so a config change still takes effect on the next start.
      container = new ManagedContainer({
        app,
        pluginId: PLUGIN_ID,
        name: CONTAINER_NAME,
        image: "grafana/grafana",
        defaultTag: "latest",
        buildConfig: (tag) => ({ ...currentContainerConfig!, tag }),
        readiness: { port: 3000, path: "/api/health", maxMs: 90_000 },
        updates: {
          versionSource: { githubReleases: "grafana/grafana" },
          currentTag: () => currentConfig?.grafanaVersion ?? "latest",
        },
      });
      registerUpdateRoutesOnce();
    }

    let healthy = true;
    try {
      await container.start(config.grafanaVersion ?? "latest");
    } catch (err) {
      // WHY soft-fail on not-ready: the container is up but Grafana is slow (first boot on a Pi) — keep the old behavior of continuing with a warning instead of failing the whole start.
      if (err instanceof ContainerHelperError && err.code === "not-ready") {
        healthy = false;
      } else {
        throw err;
      }
    }
    writeFileSync(hashFile, provisioningHash);

    const grafanaUrl = `http://127.0.0.1:${config.grafanaPort}`;

    try {
      await containers.execInContainer?.("signalk-grafana", [
        "grafana",
        "cli",
        "admin",
        "reset-admin-password",
        config.adminPassword ?? "admin",
      ]);
    } catch {
      app.debug("could not set admin password");
    }

    if (healthy) {
      app.setPluginStatus(
        await startupStatusMessage(grafanaUrl, config, (msg) => app.debug(msg)),
      );
    } else {
      app.setPluginStatus(
        `Grafana container started but not responding on port ${config.grafanaPort} — check container logs`,
      );
    }

    // Background: if SK security is enabled and we don't already have a
    // cached token, drive the device-access-request flow. On approval,
    // rewrite the datasource provisioning YAML with the JWT and
    // explicitly recreate the grafana container so it re-reads
    // provisioning at boot. Default-true when the field is absent so
    // first-install (Signal K does not seed schema defaults into the
    // runtime config object) still kicks off the flow.
    const wantsToken = config.requestSignalkToken !== false;
    if (wantsToken && initialToken === undefined) {
      void ensureSignalkToken(dataDir, config).catch((err) => {
        app.debug(
          `Signal K token flow failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }
  }

  async function ensureSignalkToken(
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
        await applyToken(dataDir, config, begin.token);
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
      await applyToken(dataDir, config, token);
      app.setPluginStatus(`Grafana running at port ${config.grafanaPort}`);
    } catch (err) {
      app.setPluginError(
        `Token approved but Grafana recreate failed: ${err instanceof Error ? err.message : String(err)}. ` +
          "Restart the plugin to retry.",
      );
    }
  }

  // WHY applyUpdate on the current tag: Grafana reads provisioning only at boot and drift detection diffs mount paths, not file contents — a serialized remove + ensureRunning (no registry pull) is the only way new YAML reaches the container without racing start/stop.
  async function applyToken(
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
    if (!container) throw new Error("Grafana container is not managed yet");
    await container.applyUpdate(config.grafanaVersion ?? "latest");
    // WHY hash rewrite: the next asyncStart must not see a stale hash and recreate a second time.
    writeFileSync(
      `${dataDir}.container-hash`,
      computeProvisioningHash(dataDir),
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
  ): Promise<ContainerConfig> {
    const bind = config.bindToAllInterfaces ? "0.0.0.0" : "127.0.0.1";
    const mounts = await resolveGrafanaMounts(containers, dataDir);
    return {
      image: "grafana/grafana",
      tag: config.grafanaVersion ?? "latest",
      ports: {
        "3000/tcp": `${bind}:${config.grafanaPort}`,
      },
      networkMode: config.networkName,
      volumes: mounts.volumes,
      env: {
        // GF_PATHS_* redirects; only present when a named volume forced a whole-volume mount.
        ...mounts.env,
        GF_SECURITY_ADMIN_PASSWORD: config.adminPassword ?? "admin",
        GF_AUTH_ANONYMOUS_ENABLED: String(config.anonymousAccess ?? true),
        GF_AUTH_ANONYMOUS_ORG_ROLE: "Viewer",
        // Async on purpose — the sync install variants are fatal at startup
        // in Grafana >= 13 and crash-loop the container offline (AGENTS.md).
        GF_PLUGINS_PREINSTALL: GRAFANA_PREINSTALL_PLUGINS,
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
      startSafely(app, () => asyncStart(config));
    },

    async stop() {
      // WHY: an in-flight token poller must not outlive the plugin and write a stale token after stop().
      tokenPollerCancelled = true;
      // Serialized against any in-flight start/recreate; stops (never removes) the container and unregisters update detection. Never throws. The instance is kept so registered routes and serialization survive plugin restarts.
      await container?.stop();
      currentConfig = null;
      sessionEndpoint = null;
    },

    registerWithRouter(router: IRouter) {
      panelRouter = router;
      registerUpdateRoutesOnce();

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

          // WHY no auth: authenticating this 5s poll with a stale password
          // tripped Grafana's brute-force lockout; the probe rides the
          // anonymous Viewer instead, so it needs anonymous access on (the
          // default) and is skipped when it is off.
          const signalk =
            currentConfig.anonymousAccess === false
              ? {
                  reachable: false,
                  error: "Anonymous access disabled; cannot probe datasource",
                }
              : await probeSignalkDatasource(grafanaUrl);

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

      // Update routes (/api/update/check + /api/update/apply) are mounted by registerUpdateRoutesOnce against the ManagedContainer.

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
          if (!containers?.getRuntime() || !containers.execInContainer) {
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
