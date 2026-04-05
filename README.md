# signalk-grafana

Managed Grafana with auto-provisioned QuestDB dashboards for Signal K.

Runs Grafana in a container (via [signalk-container](https://github.com/dirkwa/signalk-container)), automatically connects it to [signalk-questdb](https://github.com/dirkwa/signalk-questdb) via a shared container network, and provisions pre-built marine dashboards.

## Features

- **Zero-config Grafana** -- container managed automatically, no manual setup
- **Auto-provisioned QuestDB datasource** -- connects via container DNS, no 0.0.0.0 binding needed
- **Shared container network** -- Grafana and QuestDB communicate on a private Podman/Docker network
- **Pre-built dashboards** -- navigation, electrical, engine, environment
- **Anonymous access** -- view dashboards without login (configurable)
- **Config panel** -- Grafana status, open link, settings, all in Admin UI
- **Table auto-discovery** -- QuestDB supports `information_schema`, Grafana query builder works

## How It Works

1. Plugin creates a Podman/Docker network (`sk-network`)
2. Connects the existing QuestDB container to the network
3. Generates Grafana provisioning files (datasource + dashboards)
4. Starts Grafana container on the same network
5. Grafana connects to QuestDB via `sk-signalk-questdb:8812` (container DNS)

No ports exposed to the internet. Grafana UI is accessible on the host at the configured port (default `3001`).

## Pre-built Dashboards

| Dashboard       | Panels                                            |
| --------------- | ------------------------------------------------- |
| **Navigation**  | SOG (kn), COG, depth, heading                     |
| **Electrical**  | Battery voltage/current, AC power/voltage         |
| **Engine**      | RPM, coolant temp, oil pressure, fuel level       |
| **Environment** | Wind speed/angle, barometric pressure, water temp |

All queries convert Signal K units (radians, Kelvin, m/s, Pascals) to display units (degrees, Celsius, knots, hPa).

Dashboards are editable in Grafana -- customize panels, add new queries, save changes. The provisioned versions are templates to get started.

## Configuration

| Setting           | Default           | Description                               |
| ----------------- | ----------------- | ----------------------------------------- |
| Grafana port      | `3001`            | Host port for Grafana UI                  |
| Image version     | `latest`          | Grafana Docker image tag                  |
| Admin password    | `admin`           | Initial admin password (set on first run) |
| Anonymous access  | `true`            | Allow viewing without login               |
| QuestDB container | `signalk-questdb` | Container name (without sk- prefix)       |
| PostgreSQL port   | `8812`            | QuestDB PG wire port                      |
| Network name      | `sk-network`      | Shared container network name             |

## Requirements

- Node.js >= 22
- [signalk-container](https://github.com/dirkwa/signalk-container) plugin
- [signalk-questdb](https://github.com/dirkwa/signalk-questdb) plugin (for data)
- Signal K server

## License

MIT
