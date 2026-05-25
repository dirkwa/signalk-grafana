import { describe, it, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  awaitApproval,
  beginTokenRequest,
  readCachedToken,
  writeCachedToken,
} from "../signalk-token";

let dataDir: string;
let originalFetch: typeof globalThis.fetch;

before(() => {
  originalFetch = globalThis.fetch;
});

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "grafana-token-test-"));
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  rmSync(dataDir, { recursive: true, force: true });
});

function makeFetchResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Minimal stub that records every call and returns a fixed response. We
// don't pull in a mock library — node:test runs without vitest, and the
// surface area we exercise is small enough that a hand-rolled stub is
// clearer than mocking.
type FetchStub = ((
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>) & { calls: Array<{ url: string; init?: RequestInit }> };

function stubFetch(
  fn: (call: number, url: string, init?: RequestInit) => Promise<Response>,
): FetchStub {
  const calls: FetchStub["calls"] = [];
  const stub = ((
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    calls.push({ url, init });
    return fn(calls.length, url, init);
  }) as FetchStub;
  stub.calls = calls;
  globalThis.fetch = stub;
  return stub;
}

describe("signalk-token: cache helpers", () => {
  it("readCachedToken returns undefined when file missing", () => {
    assert.equal(readCachedToken(dataDir), undefined);
  });

  it("readCachedToken trims and returns the token", () => {
    writeFileSync(join(dataDir, "signalk-token"), "  eyJabc.def\n");
    assert.equal(readCachedToken(dataDir), "eyJabc.def");
  });

  it("readCachedToken treats an empty file as absent", () => {
    writeFileSync(join(dataDir, "signalk-token"), "   \n");
    assert.equal(readCachedToken(dataDir), undefined);
  });

  it("writeCachedToken persists with mode 0600", () => {
    writeCachedToken(dataDir, "eyJabc.def");
    const path = join(dataDir, "signalk-token");
    assert.ok(existsSync(path));
    assert.equal(readFileSync(path, "utf8"), "eyJabc.def");
    // Skip the mode assertion on Windows where chmod is a no-op.
    if (process.platform !== "win32") {
      const mode = statSync(path).mode & 0o777;
      assert.equal(mode, 0o600);
    }
  });
});

describe("signalk-token: beginTokenRequest", () => {
  it("returns kind=cached when a token is already on disk", async () => {
    writeFileSync(join(dataDir, "signalk-token"), "cached-tok");
    const result = await beginTokenRequest({
      dataDir,
      signalkPort: 3000,
      clientId: "test",
      description: "test",
    });
    assert.deepEqual(result, { kind: "cached", token: "cached-tok" });
  });

  it("returns kind=no-security on HTTP 404", async () => {
    stubFetch(() =>
      Promise.resolve(makeFetchResponse(404, { message: "security off" })),
    );
    const result = await beginTokenRequest({
      dataDir,
      signalkPort: 3000,
      clientId: "test",
      description: "test",
    });
    assert.deepEqual(result, { kind: "no-security" });
  });

  it("returns kind=requests-disabled on HTTP 403", async () => {
    stubFetch(() => Promise.resolve(makeFetchResponse(403, {})));
    const result = await beginTokenRequest({
      dataDir,
      signalkPort: 3000,
      clientId: "test",
      description: "test",
    });
    assert.deepEqual(result, { kind: "requests-disabled" });
  });

  it("returns kind=pending with the href when SK accepts the request", async () => {
    stubFetch(() =>
      Promise.resolve(
        makeFetchResponse(202, {
          state: "PENDING",
          requestId: "req-123",
          statusCode: 202,
          href: "/signalk/v1/requests/req-123",
        }),
      ),
    );
    const result = await beginTokenRequest({
      dataDir,
      signalkPort: 3000,
      clientId: "test",
      description: "test",
    });
    assert.deepEqual(result, {
      kind: "pending",
      requestId: "req-123",
      href: "/signalk/v1/requests/req-123",
    });
  });

  it("caches the token and returns kind=cached when SK already has approval on file", async () => {
    stubFetch(() =>
      Promise.resolve(
        makeFetchResponse(200, {
          state: "COMPLETED",
          requestId: "req-abc",
          statusCode: 200,
          accessRequest: { permission: "APPROVED", token: "instant-tok" },
        }),
      ),
    );
    const result = await beginTokenRequest({
      dataDir,
      signalkPort: 3000,
      clientId: "test",
      description: "test",
    });
    assert.deepEqual(result, { kind: "cached", token: "instant-tok" });
    assert.equal(readCachedToken(dataDir), "instant-tok");
  });

  it("returns kind=error on network failure", async () => {
    stubFetch(() => Promise.reject(new Error("ECONNREFUSED")));
    const result = await beginTokenRequest({
      dataDir,
      signalkPort: 3000,
      clientId: "test",
      description: "test",
    });
    assert.equal(result.kind, "error");
    if (result.kind === "error") {
      assert.ok(result.message.includes("ECONNREFUSED"));
    }
  });

  it("uses the POST endpoint with the clientId and permissions", async () => {
    const stub = stubFetch(() =>
      Promise.resolve(
        makeFetchResponse(202, {
          state: "PENDING",
          requestId: "r",
          statusCode: 202,
          href: "/x",
        }),
      ),
    );
    await beginTokenRequest({
      dataDir,
      signalkPort: 3000,
      clientId: "grafana-test",
      description: "Grafana plugin test",
      permissions: "readwrite",
    });
    assert.equal(
      stub.calls[0].url,
      "http://127.0.0.1:3000/signalk/v1/access/requests",
    );
    assert.equal(stub.calls[0].init?.method, "POST");
    const body = JSON.parse(stub.calls[0].init?.body as string) as Record<
      string,
      string
    >;
    assert.equal(body.clientId, "grafana-test");
    assert.equal(body.permissions, "readwrite");
  });
});

describe("signalk-token: awaitApproval", () => {
  it("returns the token when the request transitions to COMPLETED with a token", async () => {
    const stub = stubFetch((call) => {
      if (call === 1) {
        return Promise.resolve(
          makeFetchResponse(200, { state: "PENDING", requestId: "r" }),
        );
      }
      return Promise.resolve(
        makeFetchResponse(200, {
          state: "COMPLETED",
          requestId: "r",
          accessRequest: { permission: "APPROVED", token: "approved-tok" },
        }),
      );
    });
    const token = await awaitApproval(
      "/signalk/v1/requests/r",
      3000,
      () => false,
      () => {},
      5,
    );
    assert.equal(token, "approved-tok");
    assert.ok(stub.calls.length >= 2);
  });

  it("returns undefined when the admin denies (COMPLETED without a token)", async () => {
    stubFetch(() =>
      Promise.resolve(
        makeFetchResponse(200, {
          state: "COMPLETED",
          requestId: "r",
          accessRequest: { permission: "DENIED" },
        }),
      ),
    );
    const token = await awaitApproval(
      "/signalk/v1/requests/r",
      3000,
      () => false,
      () => {},
      5,
    );
    assert.equal(token, undefined);
  });

  it("returns undefined when isCancelled becomes true mid-poll", async () => {
    let cancelled = false;
    stubFetch(() =>
      Promise.resolve(
        makeFetchResponse(200, { state: "PENDING", requestId: "r" }),
      ),
    );
    setTimeout(() => {
      cancelled = true;
    }, 20);
    const token = await awaitApproval(
      "/signalk/v1/requests/r",
      3000,
      () => cancelled,
      () => {},
      5,
    );
    assert.equal(token, undefined);
  });

  it("resolves a relative href against http://127.0.0.1:port", async () => {
    const stub = stubFetch(() =>
      Promise.resolve(
        makeFetchResponse(200, {
          state: "COMPLETED",
          requestId: "r",
          accessRequest: { token: "t" },
        }),
      ),
    );
    await awaitApproval(
      "/signalk/v1/requests/r",
      4321,
      () => false,
      () => {},
      5,
    );
    assert.equal(
      stub.calls[0].url,
      "http://127.0.0.1:4321/signalk/v1/requests/r",
    );
  });
});
