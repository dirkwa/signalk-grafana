import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FetchLike, probeSignalkDatasource } from "../grafana-datasource-probe";

const GRAFANA = "http://127.0.0.1:3001";

// Route-keyed fake: maps a URL substring to a canned response or a throw.
function fetchStub(
  routes: Record<string, { status: number; body?: unknown } | Error>,
): FetchLike {
  return async (url) => {
    for (const [needle, r] of Object.entries(routes)) {
      if (!url.includes(needle)) continue;
      if (r instanceof Error) throw r;
      return {
        ok: r.status >= 200 && r.status < 300,
        status: r.status,
        json: async () => r.body,
      };
    }
    throw new Error(`unrouted url in test: ${url}`);
  };
}

describe("probeSignalkDatasource", () => {
  it("reports reachable with version and cleaned url on a discovery doc", async () => {
    const result = await probeSignalkDatasource(
      GRAFANA,
      fetchStub({
        "/api/datasources/name/Signal%20K": {
          status: 200,
          body: { uid: "abc123" },
        },
        "/api/datasources/proxy/uid/abc123/signalk": {
          status: 200,
          body: {
            server: { version: "2.19.0" },
            endpoints: {
              v1: { "signalk-http": "http://host:80/signalk/v1/api/" },
            },
          },
        },
      }),
    );
    assert.deepEqual(result, {
      reachable: true,
      version: "2.19.0",
      url: "http://host:80",
    });
  });

  it("reports not provisioned on a 404 datasource lookup", async () => {
    const result = await probeSignalkDatasource(
      GRAFANA,
      fetchStub({
        "/api/datasources/name/Signal%20K": { status: 404 },
      }),
    );
    assert.deepEqual(result, {
      reachable: false,
      error: "Datasource not provisioned",
    });
  });

  it("reports the proxy status when the datasource target is unreachable", async () => {
    // Reverse-proxy topology: the datasource URL points at a port the Grafana container cannot reach, so Grafana's proxy answers 502.
    const result = await probeSignalkDatasource(
      GRAFANA,
      fetchStub({
        "/api/datasources/name/Signal%20K": {
          status: 200,
          body: { uid: "abc123" },
        },
        "/api/datasources/proxy/uid/abc123/signalk": { status: 502 },
      }),
    );
    assert.deepEqual(result, { reachable: false, error: "HTTP 502" });
  });

  it("reports the uid gap instead of throwing on a malformed datasource", async () => {
    const result = await probeSignalkDatasource(
      GRAFANA,
      fetchStub({
        "/api/datasources/name/Signal%20K": { status: 200, body: {} },
      }),
    );
    assert.deepEqual(result, {
      reachable: false,
      error: "Datasource has no uid",
    });
  });

  it("passes an abort signal so a hung Grafana cannot stall the probe", async () => {
    const seenSignals: (AbortSignal | undefined)[] = [];
    const withSignalSpy: FetchLike = async (url, init) => {
      seenSignals.push(init?.signal);
      return { ok: true, status: 200, json: async () => ({ uid: "u1" }) };
    };
    await probeSignalkDatasource(GRAFANA, withSignalSpy);
    assert.ok(seenSignals.length >= 2);
    for (const s of seenSignals) assert.ok(s instanceof AbortSignal);
  });

  it("captures transport errors as unreachable", async () => {
    const result = await probeSignalkDatasource(
      GRAFANA,
      fetchStub({
        "/api/datasources/name/Signal%20K": new Error("fetch failed"),
      }),
    );
    assert.deepEqual(result, { reachable: false, error: "fetch failed" });
  });
});
