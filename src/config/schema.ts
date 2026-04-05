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
  }),
  adminPassword: Type.String({
    default: "admin",
    title: "Admin password",
    description: "Initial Grafana admin password (set on first run)",
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
  questdbPgPort: Type.Number({
    default: 8812,
    title: "QuestDB PostgreSQL port",
  }),
  networkName: Type.String({
    default: "sk-network",
    title: "Container network name",
    description: "Shared Podman/Docker network for Grafana to reach QuestDB",
  }),
});

export type Config = Static<typeof ConfigSchema>;
