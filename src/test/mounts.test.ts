import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  GRAFANA_DATA_DIR,
  GRAFANA_PROVISIONING_DIR,
  MountResolution,
  resolveGrafanaMounts,
  shapeGrafanaMounts,
} from "../mounts";

const DATA_DIR = "/home/node/.signalk/plugin-config-data/signalk-grafana";

describe("shapeGrafanaMounts", () => {
  it("mounts bind sources at the standard destinations without env", () => {
    const { volumes, env } = shapeGrafanaMounts(
      { source: `${DATA_DIR}/provisioning`, subPath: "" },
      { source: `${DATA_DIR}/grafana-data`, subPath: "" },
    );
    assert.deepEqual(volumes, {
      [GRAFANA_PROVISIONING_DIR]: `${DATA_DIR}/provisioning`,
      [GRAFANA_DATA_DIR]: `${DATA_DIR}/grafana-data`,
    });
    assert.deepEqual(env, {});
  });

  it("joins subPath into bind sources from older signalk-container versions", () => {
    const { volumes, env } = shapeGrafanaMounts(
      {
        source: "/opt/signalk",
        subPath: "plugin-config-data/signalk-grafana/provisioning",
      },
      {
        source: "/opt/signalk",
        subPath: "plugin-config-data/signalk-grafana/grafana-data",
      },
    );
    assert.deepEqual(volumes, {
      [GRAFANA_PROVISIONING_DIR]:
        "/opt/signalk/plugin-config-data/signalk-grafana/provisioning",
      [GRAFANA_DATA_DIR]:
        "/opt/signalk/plugin-config-data/signalk-grafana/grafana-data",
    });
    assert.deepEqual(env, {});
  });

  it("mounts a parent-covering named volume whole and redirects via GF_PATHS_*", () => {
    const vol = "ai-sailing-sla2-signalk_signalk-race-config";
    const { volumes, env } = shapeGrafanaMounts(
      {
        source: vol,
        subPath: "plugin-config-data/signalk-grafana/provisioning",
      },
      {
        source: vol,
        subPath: "plugin-config-data/signalk-grafana/grafana-data",
      },
    );
    // One whole-volume mount, not two — both directories live in the same volume.
    assert.deepEqual(volumes, { [`/signalk-vols/${vol}`]: vol });
    assert.deepEqual(env, {
      GF_PATHS_PROVISIONING: `/signalk-vols/${vol}/plugin-config-data/signalk-grafana/provisioning`,
      GF_PATHS_DATA: `/signalk-vols/${vol}/plugin-config-data/signalk-grafana/grafana-data`,
    });
  });

  it("mounts an exact-match named volume at the standard destination without env", () => {
    const { volumes, env } = shapeGrafanaMounts(
      { source: "grafana-provisioning", subPath: "" },
      { source: "grafana-data", subPath: "" },
    );
    assert.deepEqual(volumes, {
      [GRAFANA_PROVISIONING_DIR]: "grafana-provisioning",
      [GRAFANA_DATA_DIR]: "grafana-data",
    });
    assert.deepEqual(env, {});
  });

  it("handles a bind and a parent-covering volume independently", () => {
    const { volumes, env } = shapeGrafanaMounts(
      { source: `${DATA_DIR}/provisioning`, subPath: "" },
      {
        source: "sk-config",
        subPath: "plugin-config-data/signalk-grafana/grafana-data",
      },
    );
    assert.deepEqual(volumes, {
      [GRAFANA_PROVISIONING_DIR]: `${DATA_DIR}/provisioning`,
      "/signalk-vols/sk-config": "sk-config",
    });
    assert.deepEqual(env, {
      GF_PATHS_DATA:
        "/signalk-vols/sk-config/plugin-config-data/signalk-grafana/grafana-data",
    });
  });

  it("keeps two distinct parent-covering volumes on separate mount roots", () => {
    const { volumes, env } = shapeGrafanaMounts(
      { source: "vol-a", subPath: "prov" },
      { source: "vol-b", subPath: "data" },
    );
    assert.deepEqual(volumes, {
      "/signalk-vols/vol-a": "vol-a",
      "/signalk-vols/vol-b": "vol-b",
    });
    assert.deepEqual(env, {
      GF_PATHS_PROVISIONING: "/signalk-vols/vol-a/prov",
      GF_PATHS_DATA: "/signalk-vols/vol-b/data",
    });
  });
});

describe("resolveGrafanaMounts", () => {
  it("falls back to in-container paths without a resolveHostPath method", async () => {
    const { volumes, env } = await resolveGrafanaMounts(undefined, DATA_DIR);
    assert.deepEqual(volumes, {
      [GRAFANA_PROVISIONING_DIR]: `${DATA_DIR}/provisioning`,
      [GRAFANA_DATA_DIR]: `${DATA_DIR}/grafana-data`,
    });
    assert.deepEqual(env, {});
  });

  it("falls back per path when resolveHostPath returns null or throws", async () => {
    const resolver = {
      resolveHostPath: async (
        absPath: string,
      ): Promise<MountResolution | null> => {
        if (absPath.endsWith("/provisioning"))
          throw new Error("inspect failed");
        return null;
      },
    };
    const { volumes } = await resolveGrafanaMounts(resolver, DATA_DIR);
    assert.deepEqual(volumes, {
      [GRAFANA_PROVISIONING_DIR]: `${DATA_DIR}/provisioning`,
      [GRAFANA_DATA_DIR]: `${DATA_DIR}/grafana-data`,
    });
  });

  it("passes each path through the resolver", async () => {
    const asked: string[] = [];
    const resolver = {
      resolveHostPath: async (absPath: string): Promise<MountResolution> => {
        asked.push(absPath);
        return {
          source: "cfg-vol",
          subPath: absPath.split("/").pop() as string,
        };
      },
    };
    const { volumes, env } = await resolveGrafanaMounts(resolver, DATA_DIR);
    assert.deepEqual(asked, [
      `${DATA_DIR}/provisioning`,
      `${DATA_DIR}/grafana-data`,
    ]);
    assert.deepEqual(volumes, { "/signalk-vols/cfg-vol": "cfg-vol" });
    assert.deepEqual(env, {
      GF_PATHS_PROVISIONING: "/signalk-vols/cfg-vol/provisioning",
      GF_PATHS_DATA: "/signalk-vols/cfg-vol/grafana-data",
    });
  });
});
