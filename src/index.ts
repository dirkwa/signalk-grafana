import { readFileSync, writeFileSync } from "fs";
import { IRouter } from "express";
import { Config, ConfigSchema } from "./config/schema";
import { generateProvisioning } from "./provisioning";

interface App {
  debug: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  setPluginStatus: (msg: string) => void;
  setPluginError: (msg: string) => void;
  getDataDirPath: () => string;
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
}

module.exports = (app: App) => {
  let currentConfig: Config | null = null;

  async function asyncStart(config: Config) {
    currentConfig = config;
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

    app.setPluginStatus("Generating Grafana provisioning...");
    generateProvisioning(dataDir, config);

    const bind = config.bindToAllInterfaces ? "0.0.0.0" : "127.0.0.1";
    const containerConfig = {
      image: "grafana/grafana",
      tag: config.grafanaVersion ?? "latest",
      ports: {
        "3000/tcp": `${bind}:${config.grafanaPort}`,
      },
      networkMode: config.networkName,
      volumes: {
        "/etc/grafana/provisioning": `${dataDir}/provisioning`,
        "/var/lib/grafana/dashboards": `${dataDir}/dashboards`,
        "/var/lib/grafana": `${dataDir}/grafana-data`,
      },
      env: {
        GF_SECURITY_ADMIN_PASSWORD: config.adminPassword ?? "admin",
        GF_AUTH_ANONYMOUS_ENABLED: String(config.anonymousAccess ?? true),
        GF_AUTH_ANONYMOUS_ORG_ROLE: "Viewer",
        GF_PLUGINS_PREINSTALL: "tkurki-signalk-datasource",
        GF_FEATURE_TOGGLES_DISABLE: "backgroundPluginInstaller",
        GF_SECURITY_ALLOW_EMBEDDING: "true",
      },
      restart: "unless-stopped",
    };

    const configHash = JSON.stringify({
      tag: containerConfig.tag,
      ports: containerConfig.ports,
      env: containerConfig.env,
      networkMode: containerConfig.networkMode,
    });
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
          if (healthRes.ok) {
            const health = (await healthRes.json()) as {
              version?: string;
            };
            res.json({
              status: "running",
              port: currentConfig.grafanaPort,
              version: health.version || "unknown",
            });
          } else {
            res.status(503).json({ status: "unhealthy" });
          }
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
            const pc = current.split(".").map(Number);
            const pl = latest.split(".").map(Number);
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
          await containers.ensureRunning("signalk-grafana", {
            image: "grafana/grafana",
            tag: newTag,
            ports: {
              "3000/tcp": `${currentConfig?.bindToAllInterfaces ? "0.0.0.0" : "127.0.0.1"}:${currentConfig?.grafanaPort ?? 3001}`,
            },
            networkMode: currentConfig?.networkName ?? "sk-network",
            volumes: {
              "/etc/grafana/provisioning": `${app.getDataDirPath()}/provisioning`,
              "/var/lib/grafana/dashboards": `${app.getDataDirPath()}/dashboards`,
              "/var/lib/grafana": `${app.getDataDirPath()}/grafana-data`,
            },
            env: {
              GF_SECURITY_ADMIN_PASSWORD:
                currentConfig?.adminPassword ?? "admin",
              GF_AUTH_ANONYMOUS_ENABLED: String(
                currentConfig?.anonymousAccess ?? true,
              ),
              GF_AUTH_ANONYMOUS_ORG_ROLE: "Viewer",
              GF_PLUGINS_PREINSTALL: "tkurki-signalk-datasource",
              GF_FEATURE_TOGGLES_DISABLE: "backgroundPluginInstaller",
              GF_SECURITY_ALLOW_EMBEDDING: "true",
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

      router.post("/api/set-password", async (req, res) => {
        try {
          const containers = (globalThis as any).__signalk_containerManager as
            | ContainerManagerApi
            | undefined;
          if (!containers || !containers.getRuntime()) {
            res.status(503).json({ error: "Container manager not available" });
            return;
          }

          const password = currentConfig?.adminPassword ?? "admin";
          const result = await containers.execInContainer("signalk-grafana", [
            "grafana",
            "cli",
            "admin",
            "reset-admin-password",
            password,
          ]);

          if (result.exitCode === 0) {
            res.json({
              status: "ok",
              message: "Admin password updated.",
            });
          } else {
            res.status(500).json({
              error: result.stderr || "Failed to set password",
            });
          }
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
