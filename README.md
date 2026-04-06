# signalk-grafana

Managed Grafana with auto-provisioned QuestDB and Signal K datasources for Signal K.

Runs Grafana in a container (via [signalk-container](https://github.com/dirkwa/signalk-container)), automatically connects it to [signalk-questdb](https://github.com/dirkwa/signalk-questdb) via a shared container network, and provisions both datasources.

## Features

- **Zero-config Grafana** -- container managed automatically, no manual setup
- **Auto-provisioned datasources** -- QuestDB (PostgreSQL) and Signal K datasources configured automatically
- **Shared container network** -- Grafana and QuestDB communicate on a private Podman/Docker network
- **Table auto-discovery** -- QuestDB supports `information_schema`, Grafana query builder works
- **Anonymous access** -- view dashboards without login (configurable)
- **One-click update** -- check for new Grafana versions and update from the config panel
- **Password management** -- set admin password from Signal K config panel
- **Config panel** -- Grafana status with direct link, settings, all in Admin UI

## How It Works

1. Plugin creates a Podman/Docker network (`sk-network`)
2. Starts Grafana container on the network
3. Auto-provisions QuestDB datasource (connects via container DNS `sk-signalk-questdb:8812`)
4. Auto-provisions Signal K datasource (connects via `host.containers.internal`)
5. Sets admin password on every startup to match config

QuestDB must also be on `sk-network` -- set **Container network** to `sk-network` in the QuestDB plugin config.

## Example Queries

Create dashboards in Grafana using the **QuestDB** datasource with raw SQL. QuestDB uses `SAMPLE BY` for time bucketing:

**Speed Over Ground (knots):**

```sql
SELECT ts AS "time", avg(value) * 1.94384 AS "SOG"
FROM signalk
WHERE path = 'navigation.speedOverGround'
  AND context = 'self'
  AND ts >= $__timeFrom() AND ts <= $__timeTo()
SAMPLE BY 10s
```

**Wind Speed and Angle:**

```sql
SELECT ts AS "time",
  avg(value) * 1.94384 AS "AWS"
FROM signalk
WHERE path = 'environment.wind.speedApparent'
  AND context = 'self'
  AND ts >= $__timeFrom() AND ts <= $__timeTo()
SAMPLE BY 10s
```

**Battery Voltage:**

```sql
SELECT ts AS "time", avg(value) AS "Voltage"
FROM signalk
WHERE path LIKE 'electrical.batteries.%.voltage'
  AND context = 'self'
  AND ts >= $__timeFrom() AND ts <= $__timeTo()
SAMPLE BY 10s
```

**Engine RPM (rev/s to RPM):**

```sql
SELECT ts AS "time", avg(value) * 60 AS "RPM"
FROM signalk
WHERE path LIKE 'propulsion.%.revolutions'
  AND context = 'self'
  AND ts >= $__timeFrom() AND ts <= $__timeTo()
SAMPLE BY 10s
```

**Temperature (Kelvin to Celsius):**

```sql
SELECT ts AS "time", avg(value) - 273.15 AS "Temp"
FROM signalk
WHERE path = 'environment.water.temperature'
  AND context = 'self'
  AND ts >= $__timeFrom() AND ts <= $__timeTo()
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

Use these Grafana PostgreSQL macros in your queries:

| Macro           | Expands to                   |
| --------------- | ---------------------------- |
| `$__timeFrom()` | Start of selected time range |
| `$__timeTo()`   | End of selected time range   |

QuestDB's `SAMPLE BY` handles time bucketing (e.g., `SAMPLE BY 10s`, `SAMPLE BY 1m`, `SAMPLE BY 1h`).

## Configuration

| Setting               | Default           | Description                                     |
| --------------------- | ----------------- | ----------------------------------------------- |
| Grafana port          | `3001`            | Host port for Grafana UI                        |
| Image version         | `latest`          | Grafana Docker image tag                        |
| Admin password        | `admin`           | Grafana admin password (applied on every start) |
| Anonymous access      | `true`            | Allow viewing without login                     |
| Signal K URL override | auto              | Auto-detected, only set to override             |
| QuestDB container     | `signalk-questdb` | Container name (without sk- prefix)             |
| PostgreSQL port       | `8812`            | QuestDB PG wire port                            |
| Network name          | `sk-network`      | Shared container network name                   |
| Bind to 0.0.0.0       | `false`           | Expose Grafana outside localhost                |

## Requirements

- Node.js >= 22
- [signalk-container](https://github.com/dirkwa/signalk-container) plugin
- [signalk-questdb](https://github.com/dirkwa/signalk-questdb) plugin (with network set to `sk-network`)
- Signal K server

## License

MIT
