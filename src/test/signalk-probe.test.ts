import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  GetError,
  GetResult,
  ProbeTransports,
  probeResultToEndpoint,
  probeSignalkEndpoint,
  resolveProbeHttpPort,
} from "../signalk-probe.js";

const DISCOVERY = JSON.stringify({
  endpoints: { v1: { version: "2.28.0" } },
  server: { id: "signalk-server-node", version: "2.28.0" },
});

const ok = (): GetResult => ({ status: 200, body: DISCOVERY });
const redirect = (location: string): GetResult => ({
  status: 302,
  body: "",
  location,
});
const reject = (code: string): Promise<GetResult> =>
  Promise.reject<GetResult>({ code } as GetError);

function transports(overrides: Partial<ProbeTransports>): ProbeTransports {
  return {
    httpGet: () => reject("ECONNREFUSED"),
    httpsGetStrict: () => reject("ECONNREFUSED"),
    httpsGetLax: () => reject("ECONNREFUSED"),
    ...overrides,
  };
}

const noSleep = () => Promise.resolve();
const baseOpts = { httpPort: 3000, dataDir: "/nonexistent", sleep: noSleep };

describe("probeSignalkEndpoint", () => {
  it("reports plain http when the http port serves the discovery doc", async () => {
    const result = await probeSignalkEndpoint({
      ...baseOpts,
      transports: transports({ httpGet: async () => ok() }),
    });
    assert.equal(result.scheme, "http");
    assert.equal(result.port, 3000);
    assert.equal(result.selfSigned, false);
    assert.equal(result.conclusive, true);
  });

  it("follows a 302 to https and detects a self-signed cert", async () => {
    const result = await probeSignalkEndpoint({
      ...baseOpts,
      httpPort: 80,
      transports: transports({
        httpGet: async () =>
          redirect("https://host.containers.internal:443/signalk"),
        httpsGetStrict: () => reject("SELF_SIGNED_CERT_IN_CHAIN"),
        httpsGetLax: async () => ok(),
      }),
    });
    assert.equal(result.scheme, "https");
    assert.equal(result.port, 443);
    assert.equal(result.selfSigned, true);
    assert.equal(result.conclusive, true);
  });

  it("reports a trusted cert when strict https succeeds", async () => {
    const result = await probeSignalkEndpoint({
      ...baseOpts,
      httpPort: 80,
      transports: transports({
        httpGet: async () => redirect("https://x:443/signalk"),
        httpsGetStrict: async () => ok(),
      }),
    });
    assert.equal(result.scheme, "https");
    assert.equal(result.selfSigned, false);
    assert.equal(result.conclusive, true);
  });

  it("normalizes a port-less https Location to 443", async () => {
    const result = await probeSignalkEndpoint({
      ...baseOpts,
      httpPort: 80,
      transports: transports({
        httpGet: async () =>
          redirect("https://host.containers.internal/signalk"),
        httpsGetLax: async (port) =>
          port === 443 ? ok() : reject("ECONNREFUSED"),
        httpsGetStrict: () => reject("SELF_SIGNED_CERT_IN_CHAIN"),
      }),
    });
    assert.equal(result.port, 443);
    assert.equal(result.scheme, "https");
  });

  it("falls back to a reachable sslport hint when the Location port is dead", async () => {
    const result = await probeSignalkEndpoint({
      ...baseOpts,
      httpPort: 80,
      sslportHint: 8443,
      transports: transports({
        httpGet: async () =>
          redirect("https://host.containers.internal:9999/signalk"),
        httpsGetStrict: (port) =>
          port === 8443
            ? Promise.reject<GetResult>({
                code: "SELF_SIGNED_CERT_IN_CHAIN",
              } as GetError)
            : reject("ECONNREFUSED"),
        httpsGetLax: async (port) =>
          port === 8443 ? ok() : reject("ECONNREFUSED"),
      }),
    });
    assert.equal(result.port, 8443);
    assert.equal(result.conclusive, true);
  });

  it("treats a TLS handshake error on the http port as https on that port", async () => {
    const result = await probeSignalkEndpoint({
      ...baseOpts,
      httpPort: 443,
      transports: transports({
        httpGet: () => reject("EPROTO"),
        httpsGetStrict: async () => ok(),
      }),
    });
    assert.equal(result.scheme, "https");
    assert.equal(result.port, 443);
  });

  it("retries a refused http port and then succeeds", async () => {
    let calls = 0;
    const result = await probeSignalkEndpoint({
      ...baseOpts,
      transports: transports({
        httpGet: async () => {
          calls += 1;
          if (calls < 2) return reject("ECONNREFUSED");
          return ok();
        },
      }),
    });
    assert.equal(calls, 2);
    assert.equal(result.scheme, "http");
    assert.equal(result.conclusive, true);
  });

  it("is inconclusive http when nothing is listening", async () => {
    const result = await probeSignalkEndpoint({ ...baseOpts });
    assert.equal(result.conclusive, false);
    assert.equal(result.scheme, "http");
  });

  it("is inconclusive https when redirect seen but no port confirms", async () => {
    const result = await probeSignalkEndpoint({
      ...baseOpts,
      httpPort: 80,
      transports: transports({
        httpGet: async () =>
          redirect("https://host.containers.internal:443/signalk"),
      }),
    });
    assert.equal(result.conclusive, false);
    assert.equal(result.scheme, "https");
  });
});

describe("probeResultToEndpoint", () => {
  it("maps https to ssl + tlsSkipVerify", () => {
    const ep = probeResultToEndpoint({
      conclusive: true,
      scheme: "https",
      port: 443,
      selfSigned: true,
    });
    assert.deepEqual(ep, {
      host: "host.containers.internal:443",
      ssl: true,
      tlsSkipVerify: true,
    });
  });

  it("maps http to no ssl and no skip", () => {
    const ep = probeResultToEndpoint({
      conclusive: true,
      scheme: "http",
      port: 3000,
      selfSigned: false,
    });
    assert.deepEqual(ep, {
      host: "host.containers.internal:3000",
      ssl: false,
      tlsSkipVerify: false,
    });
  });

  it("reuses the last-good endpoint when the probe is inconclusive", () => {
    const lastGood = {
      host: "host.containers.internal:443",
      ssl: true,
      tlsSkipVerify: true,
    };
    const ep = probeResultToEndpoint(
      { conclusive: false, scheme: "https", port: 443, selfSigned: true },
      lastGood,
    );
    assert.equal(ep, lastGood);
  });

  it("falls back to legacy http when inconclusive with no last-good", () => {
    const ep = probeResultToEndpoint({
      conclusive: false,
      scheme: "http",
      port: 3000,
      selfSigned: false,
    });
    assert.equal(ep.ssl, false);
    assert.equal(ep.host, "host.containers.internal:3000");
  });
});

describe("resolveProbeHttpPort", () => {
  it("prefers a valid PORT env value", () => {
    assert.equal(resolveProbeHttpPort("80", 8080), 80);
  });

  it("falls back to the server settings port when PORT is unset", () => {
    assert.equal(resolveProbeHttpPort(undefined, 80), 80);
  });

  it("falls back to the settings port when PORT is garbage", () => {
    assert.equal(resolveProbeHttpPort("abc", 8080), 8080);
  });

  it("rejects ports above 65535 at each fallback level", () => {
    assert.equal(resolveProbeHttpPort("65536", 8080), 8080);
    assert.equal(resolveProbeHttpPort(undefined, 65536), 3000);
    assert.equal(resolveProbeHttpPort("65535", 8080), 65535);
  });

  it("defaults to 3000 when neither source is usable", () => {
    assert.equal(resolveProbeHttpPort(undefined, undefined), 3000);
    assert.equal(resolveProbeHttpPort("", "not-a-port"), 3000);
    assert.equal(resolveProbeHttpPort("-1", 0), 3000);
    assert.equal(resolveProbeHttpPort("3000.5", null), 3000);
  });
});
