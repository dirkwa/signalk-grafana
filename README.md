# signalk-grafana

Managed Grafana with auto-provisioned QuestDB and Signal K datasources for Signal K.

Runs Grafana in a container (via [signalk-container](https://github.com/dirkwa/signalk-container)), automatically connects it to [signalk-questdb](https://github.com/dirkwa/signalk-questdb) via a shared container network, and provisions both datasources.

## Features

- **Zero-config Grafana** -- container managed automatically, no manual setup
- **Auto-provisioned datasources** -- QuestDB (native + PostgreSQL) and Signal K datasources configured automatically
- **Shared container network** -- Grafana and QuestDB communicate on a private Podman/Docker network
- **QuestDB-native query editor** -- the official QuestDB datasource plugin is provisioned as the default, with working table introspection and a `SAMPLE BY`-aware editor (Grafana's generic PostgreSQL query builder cannot list QuestDB tables)
- **Anonymous access** -- view dashboards without login (configurable)
- **Live reachability** -- config panel shows whether Grafana can actually reach your Signal K server
- **One-click update** -- check for new Grafana versions and update from the config panel
- **Password management** -- set admin password from Signal K config panel
- **Config panel** -- Grafana status with direct link, settings, all in Admin UI
- **Backup & restore integration** -- exposes `/api/full-export/{db,dashboards,provisioning}` endpoints for [signalk-backup](https://github.com/dirkwa/signalk-backup) to pull a consistent SQLite checkpoint plus dashboard JSONs and provisioning YAMLs. On plugin start, if a kopia restore left a staged `grafana.db` on disk but the live one is missing, it's automatically copied into place before Grafana starts -- dashboards and datasources come back without any manual step.

## How It Works

1. Plugin creates a Podman/Docker network (`sk-network`)
2. Starts Grafana container on the network
3. Auto-provisions two QuestDB datasources over container DNS (`sk-<QuestDB container>:<PostgreSQL port>`, default `sk-signalk-questdb:8812`): **QuestDB (native)** (official QuestDB plugin, the default) and **QuestDB** (PostgreSQL-wire, kept so dashboards built against it keep working)
4. Auto-provisions Signal K datasource (connects via `host.containers.internal`)
5. Sets admin password on every startup to match config

Both plugins must share the same **Container network** (default `sk-network`), and the **QuestDB container** setting here must match the container name configured in the QuestDB plugin.

## Example Queries

Create dashboards in Grafana using the **QuestDB (native)** datasource -- its query builder lists the tables, and the SQL below works in its code editor as well as in the legacy **QuestDB** (PostgreSQL) datasource. QuestDB uses `SAMPLE BY` for time bucketing:

**Speed Over Ground (knots):**

```sql
SELECT ts AS "time", avg(value) * 1.94384 AS "SOG"
FROM signalk
WHERE path = 'navigation.speedOverGround'
  AND context = 'self'
  AND $__timeFilter(ts)
SAMPLE BY 10s
```

**Wind Speed and Angle:**

```sql
SELECT ts AS "time",
  avg(value) * 1.94384 AS "AWS"
FROM signalk
WHERE path = 'environment.wind.speedApparent'
  AND context = 'self'
  AND $__timeFilter(ts)
SAMPLE BY 10s
```

**Battery Voltage:**

```sql
SELECT ts AS "time", avg(value) AS "Voltage"
FROM signalk
WHERE path LIKE 'electrical.batteries.%.voltage'
  AND context = 'self'
  AND $__timeFilter(ts)
SAMPLE BY 10s
```

**Engine RPM (rev/s to RPM):**

```sql
SELECT ts AS "time", avg(value) * 60 AS "RPM"
FROM signalk
WHERE path LIKE 'propulsion.%.revolutions'
  AND context = 'self'
  AND $__timeFilter(ts)
SAMPLE BY 10s
```

**Temperature (Kelvin to Celsius):**

```sql
SELECT ts AS "time", avg(value) - 273.15 AS "Temp"
FROM signalk
WHERE path = 'environment.water.temperature'
  AND context = 'self'
  AND $__timeFilter(ts)
SAMPLE BY 10s
```

### Unit Conversions

Signal K stores values in SI units. Common conversions for Grafana:

| Conversion         | Formula               |
| ------------------ | --------------------- |
| m/s to knots       | `value * 1.94384`     |
| radians to degrees | `value * 57.2958`     |
| Kelvin to Celsius  | `value - 273.15`      |
| Pascals to hPa     | `value / 100`         |
| rev/s to RPM       | `value * 60`          |
| Pascals to PSI     | `value * 0.000145038` |

### Grafana Macros

`$__timeFilter(ts)` (the dashboard time-range condition) works in both QuestDB datasources. The other macros differ per datasource type:

| Macro                           | Datasource         | Expands to                              |
| ------------------------------- | ------------------ | --------------------------------------- |
| `$__timeFilter(ts)`             | both               | Time-range condition on the `ts` column |
| `$__fromTime` / `$__toTime`     | QuestDB (native)   | Range start / end as timestamps         |
| `$__sampleByInterval`           | QuestDB (native)   | Panel interval for `SAMPLE BY`          |
| `$__timeFrom()` / `$__timeTo()` | QuestDB (Postgres) | Range start / end                       |

QuestDB's `SAMPLE BY` handles time bucketing (e.g., `SAMPLE BY 10s`, `SAMPLE BY 1m`, `SAMPLE BY 1h`).

## Configuration

| Setting               | Default           | Description                                                                                                                                                                |
| --------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Grafana port          | `3001`            | Host port for Grafana UI                                                                                                                                                   |
| Image version         | `latest`          | Grafana Docker image tag                                                                                                                                                   |
| Admin password        | `admin`           | Grafana admin password (applied on every start)                                                                                                                            |
| Anonymous access      | `true`            | Allow viewing without login                                                                                                                                                |
| Signal K URL override | auto              | Auto-detected; set to override (use `http://` or `https://`)                                                                                                               |
| QuestDB container     | `signalk-questdb` | Container name (without sk- prefix)                                                                                                                                        |
| QuestDB host override | empty             | Bare hostname/IP for a self-hosted QuestDB (IPv6 in brackets: `[fd00::10]`); empty uses the managed QuestDB container. Must be reachable from inside the Grafana container |
| PostgreSQL port       | `8812`            | QuestDB PG wire port                                                                                                                                                       |
| Network name          | `sk-network`      | Shared container network name                                                                                                                                              |
| Bind to 0.0.0.0       | `false`           | Expose Grafana outside localhost                                                                                                                                           |
| Sub-path              | empty             | Set to `/grafana/` when running behind a reverse proxy                                                                                                                     |
| Auto-request token    | `true`            | On secured Signal K servers, request a device-access token                                                                                                                 |

### Secured Signal K servers

When Signal K security is enabled, the plugin drives the standard SK device-access-request flow on startup so the Grafana Signal K datasource can read paths and history from the secured server.

1. Plugin POSTs `/signalk/v1/access/requests` with `clientId: signalk-grafana`, `permissions: readwrite`.
2. Plugin status shows `Awaiting Signal K token approval — see Security → Access Requests`.
3. Approve in Signal K Admin → Security → Access Requests.
4. The plugin caches the JWT to `${dataDir}/signalk-token` (mode 0600), injects it into the Grafana datasource provisioning, and recreates the Grafana container so the new credentials take effect.

Disable with `requestSignalkToken: false` if you prefer to paste a token into the Grafana datasource UI manually.

#### What works and what doesn't on secured SK

| Use case                                                                           | Works on secured SK? |
| ---------------------------------------------------------------------------------- | -------------------- |
| Explore → Signal K → pick a path                                                   | ✅                   |
| Historical range queries (`from`/`to` are explicit times, or `now-1h` to `now-1m`) | ✅                   |
| `/api/health` and datasource Test button                                           | ✅                   |
| **Live-updating panels** (range `now-X to now` that streams values in real time)   | ❌                   |

The live-update gap is in the upstream `tkurki-signalk-datasource` plugin: it opens its WebSocket from the browser where Grafana's secret store is not accessible by design, so the upgrade request goes out without an `Authorization` header and Signal K rejects it. HTTP queries are unaffected because Grafana's datasource proxy injects the bearer token server-side for those. Tracked at [tkurki/signalk-grafana-datasource#12](https://github.com/tkurki/signalk-grafana-datasource/issues/12) — until that lands, **use the QuestDB datasource for live-updating panels** (the intended architecture: SK → questdb → Grafana, with the SK datasource reserved for ad-hoc Explore and historical queries).

## Requirements

- Node.js >= 22.16 (needs `node:sqlite` `backup()` for the SQLite checkpoint endpoint)
- [signalk-container](https://github.com/dirkwa/signalk-container) plugin
- [signalk-questdb](https://github.com/dirkwa/signalk-questdb) plugin (with network set to `sk-network`)
- Signal K server

## License

signalk-grafana 2.0.0 and later is **source available, not open source**.
See [LICENSE.md](LICENSE.md).

**You may**, free of charge: run it on your own boat or fleet, private or
commercial; use it for internal company operations; modify it for your own use;
use it in education and research; and provide professional services around it.

**You may not**: redistribute it, or publish a modified version of it to npm or
anywhere else. Verbatim copies of official releases may be mirrored and cached.

Versions 1.3.0 and earlier remain available under the MIT license, see
[LICENSE-MIT-through-v1.x.txt](LICENSE-MIT-through-v1.x.txt).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).
