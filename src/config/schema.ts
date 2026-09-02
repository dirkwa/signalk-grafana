import { Type, Static } from "@sinclair/typebox";

export const ConfigSchema = Type.Object({
  grafanaPort: Type.Number({
    default: 3001,
    title: "Grafana port",
    description:
      "Host port for the Grafana UI (avoid 3000 if Signal K uses it)",
  }),
  grafanaVersion: Type.String({
    default: "latest",
    title: "Grafana image version",
    description:
      "Versions below 11.3 do not support background plugin preinstall " +
      "(GF_PLUGINS_PREINSTALL); when pinning one, install the Signal K " +
      "datasource plugin manually.",
  }),
  adminPassword: Type.String({
    default: "admin",
    title: "Admin password",
    description:
      "Grafana admin password, applied on every start. The Set & Save button " +
      "changes and saves it without a full plugin restart.",
  }),
  anonymousAccess: Type.Boolean({
    default: true,
    title: "Anonymous access",
    description: "Allow viewing dashboards without login",
  }),
  questdbContainerName: Type.String({
    default: "signalk-questdb",
    title: "QuestDB container name",
    description: "Container name used by signalk-questdb (without sk- prefix)",
  }),
  questdbHost: Type.String({
    default: "",
    title: "QuestDB host override",
    description:
      "Host Grafana uses to reach QuestDB. Leave empty for the managed " +
      "container (sk-<QuestDB container name> on the shared network). Set a " +
      "hostname or IP when QuestDB is self-hosted or on another network — it " +
      "must be reachable from inside the Grafana container.",
  }),
  questdbPgPort: Type.Number({
    default: 8812,
    title: "QuestDB PostgreSQL port",
  }),
  networkName: Type.String({
    default: "sk-network",
    title: "Container network name",
    description: "Shared Podman/Docker network for Grafana to reach QuestDB",
  }),
  signalkUrl: Type.String({
    default: "",
    title: "Signal K server URL override",
    description:
      "Auto-detected on startup (scheme, port, and self-signed TLS). Only set to override " +
      "(e.g. https://192.168.0.122:443).",
  }),
  tlsSkipVerify: Type.Optional(
    Type.Boolean({
      title: "Skip TLS certificate verification",
      description:
        "Only applies with a Signal K server URL override that uses https with a self-signed " +
        "certificate. The auto-detected connection handles this on its own.",
    }),
  ),
  subPath: Type.String({
    default: "",
    title: "Sub-path (reverse proxy)",
    description:
      "Set to /grafana/ when running behind a reverse proxy. Leave empty for direct access.",
  }),
  bindToAllInterfaces: Type.Boolean({
    default: false,
    title: "Bind to 0.0.0.0",
    description:
      "Caution! This can expose Grafana to the internet. Only enable if you need remote access.",
  }),
  requestSignalkToken: Type.Boolean({
    default: true,
    title: "Request Signal K access token automatically",
    description:
      "When Signal K security is enabled, request a device-access token via the standard SK " +
      "approval flow and inject it into the Grafana Signal K datasource so dashboards can read " +
      "paths and history from the secured server. Disable to manage credentials manually.",
  }),
});

export type Config = Static<typeof ConfigSchema>;
