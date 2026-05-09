# AGENTS.md

Notes for AI coding agents working on this repository. Human-facing usage and dashboard examples live in [README.md](README.md); this file is the orientation an agent needs before making non-trivial changes.

## What this is

A Signal K server plugin that runs Grafana in a Podman/Docker container and auto-provisions both QuestDB and Signal K datasources via YAML, so opening Grafana for the first time shows a working setup. The plugin itself does not embed Grafana — it delegates container lifecycle to a sibling plugin.

## Companion plugins (hard runtime dependencies)

The plugin will refuse to start without these — they are listed in `package.json` under `signalk.requires`:

- **signalk-container** — provides the global `__signalk_containerManager` API used to create networks, pull images, start/stop/exec containers, and detect runtime (Podman vs Docker, host vs containerized Signal K). All container ops in [src/index.ts](src/index.ts) go through it.
- **signalk-questdb** — provides the QuestDB time-series store at `sk-signalk-questdb:8812` on the shared network. The QuestDB datasource YAML hard-codes that DNS name; if the user renames the QuestDB container, the QuestDB plugin's name must match `config.questdbContainerName`.

## File layout

- [src/index.ts](src/index.ts) — plugin entrypoint. Three responsibilities:
  1. `asyncStart(config)` — wait for `__signalk_containerManager`, ensure network, generate provisioning, recreate the container if its config-hash changed, start it, then exec the admin-password reset. The Grafana env passes `GF_INSTALL_PLUGINS=tkurki-signalk-datasource` so the Signal K datasource plugin loads on first boot.
  2. `registerWithRouter(router)` — exposes `/api/status`, `/api/versions`, `/api/update/check`, `/api/update/apply`, `/api/set-password`. `/api/status` resolves the Signal K datasource UID by name then probes through the Grafana proxy at `/signalk` to report reachability + server version. The config panel polls it every 5s. `/api/set-password` writes the new password back into `currentConfig.adminPassword` so the probe keeps authenticating.
  3. `stop()` — best-effort container stop, clears `currentConfig`.
- [src/provisioning.ts](src/provisioning.ts) — generates `provisioning/datasources/*.yaml` under `app.getDataDirPath()`. Both datasources are YAML-provisioned. `resolveSignalkEndpoint(config)` parses `config.signalkUrl` with `new URL()`, preserves `http`/`https`, defaults to `http://host.containers.internal:${process.env.PORT}` when no override is set, and throws on non-http(s) schemes (catches typos like `htps://`).
- [src/config/schema.ts](src/config/schema.ts) — typebox schema → Signal K admin UI form. Adding a config field starts here.
- [src/configpanel/PluginConfigurationPanel.js](src/configpanel/PluginConfigurationPanel.js) — React (19) panel rendered inside Signal K admin. JavaScript, not TypeScript; bundled by webpack via `module federation` so React is shared with the host.
- [src/test/provisioning.test.ts](src/test/provisioning.test.ts) — `node:test`, no test framework. Tests run against the compiled `dist/` (`node --test 'dist/test/**/*.test.js'`), so a stale build is the most common test failure.

## Build, lint, test

```bash
npm run format     # prettier + eslint --fix
npm run build      # tsc + webpack
npm run build:all  # build + test
npm run ci-lint    # eslint + prettier --check (no auto-fix)
npm test           # node --test on dist/
```

There is no separate `npm run dev` — the plugin runs inside a real Signal K server (see "Local dev loop").

## Local dev loop

The plugin runs inside whichever Signal K server has `signalk-grafana` in its `node_modules`. In this repo's typical dev layout, a Signal K data dir (e.g. `~/.signalk-charts-docker`) symlinks `node_modules/signalk-grafana` → `~/dev/signalk-grafana`. After editing source:

1. `npm run build:all` — webpack writes `dist/`, tests run.
2. Reload the plugin. The Signal K admin API at `/skServer/plugins/<id>/config` saves config and triggers stop+start, but **does not re-`require()` the plugin code** — Node's `require.cache` keeps the old module. To pick up code changes you must restart the Signal K _process_.
3. `curl http://127.0.0.1:<sk-port>/plugins/signalk-grafana/api/status` to confirm the new code is live.

## Debugging recipes

Inspect the running Grafana container directly — logs and on-disk plugin state often answer "why doesn't X work":

```bash
podman ps                                                  # find sk-signalk-grafana
podman logs sk-signalk-grafana | grep -iE 'tkurki|plugin'  # plugin load errors
podman exec sk-signalk-grafana ls /var/lib/grafana/plugins # what's actually installed
podman exec sk-signalk-grafana cat /etc/grafana/provisioning/datasources/questdb.yaml
```

Test datasource reachability from inside Grafana's network namespace:

```bash
podman exec sk-signalk-grafana wget -qO- http://host.containers.internal:<sk-port>/signalk
```

Probe Grafana's view of the datasources, and confirm the Signal K proxy hop works end-to-end:

```bash
curl -u admin:<pw> http://127.0.0.1:3001/api/datasources
curl -u admin:<pw> http://127.0.0.1:3001/api/datasources/proxy/uid/signalk/signalk
```

The plugin's own status endpoint surfaces the same probe result with the resolved upstream URL:

```bash
curl http://127.0.0.1:<sk-port>/plugins/signalk-grafana/api/status
```

## Gotchas

- **`host.containers.internal` works on `sk-network` for rootless Podman.** Don't assume the user-defined network breaks the magic hostname — netavark injects it. Verify before redesigning networking. (The earlier theory that the network was the problem turned out to be wrong; the actual issue was plugin load timing.)
- **The `tkurki-signalk-datasource` Grafana plugin is frontend-only.** Grafana's `/api/datasources/uid/<uid>/health` endpoint returns `{"messageId":"plugin.unavailable"}` for _any_ frontend-only datasource regardless of whether it works. Use the proxy path (`/api/datasources/proxy/uid/<uid>/signalk`) as the truthful reachability signal.
- **Grafana does not hot-reload plugins from disk.** Installing via `grafana cli plugins install` _after_ Grafana started leaves the plugin file on disk but unregistered until the next process restart. Prefer `GF_INSTALL_PLUGINS` env var (runs before plugin loader) over post-start CLI install.
- **The container is recreated when its config hash changes.** [src/index.ts](src/index.ts) hashes `{ tag, ports, env, networkMode }` and compares against `<dataDir>.container-hash`. Adding/changing an env var force-recreates on next plugin start, which is normally what you want — but means existing users see container churn whenever you touch this code.
- **`bindToAllInterfaces` controls only Grafana's host port mapping.** It has no effect on how Grafana reaches Signal K or QuestDB. Don't accept user reports that frame it as a Signal K reachability setting.
- **`process.env.PORT` inside `asyncStart` is the Signal K server's HTTP port.** That's why `host.containers.internal:${process.env.PORT}` is a sensible default for Signal K's URL: the plugin runs _inside_ the Signal K process, so its env reflects how Signal K was launched.
- **`provisioning.test.ts` runs against `dist/`, not `src/`.** If you edit `src/test/provisioning.test.ts` and run `npm test` directly, you're running the previous compiled version. Use `npm run build:all`.

## Conventions

- **No comments restating what the code does** — Signal K maintainers and the project author dislike echo comments. Comments should explain _why_ something non-obvious is the way it is (e.g. "Grafana doesn't hot-reload, so we install via env var"), not narrate the diff.
- **Angular-style commit messages** (`fix(grafana): ...`, `feat(grafana): ...`, `docs(grafana): ...`). The PR title matches the commit subject.
- **Branch names use hyphens, not slashes.** Signal K maintainers' convention.
- **TypeScript is strict.** Don't add `as any` to silence errors — fix the type.
- **Don't write multi-line comment blocks or docstrings.** A short single-line comment for a non-obvious WHY is fine; everything else is noise.
