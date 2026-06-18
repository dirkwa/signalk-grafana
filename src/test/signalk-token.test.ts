import { describe, it, beforeEach, afterEach } from "node:test";
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
  JsonResponse,
  readCachedToken,
  SignalkBase,
  Transport,
  writeCachedToken,
} from "../signalk-token";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "grafana-token-test-"));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

const httpsBase: SignalkBase = {
  scheme: "https",
  port: 443,
  tlsSkipVerify: true,
};

// JWT-shaped fixture: three base64url segments, matching the provisioning
// layer's JWT_SHAPE guard.
const JWT =
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzaWduYWxrLWdyYWZhbmEifQ.abcDEF_123-456";

const json = (status: number, body: unknown): JsonResponse => ({
  status,
  body: JSON.stringify(body),
});

// Hand-rolled transport stub: records every call and delegates to a per-call
// responder. node:test runs without a mock library and the surface is small.
type TransportStub = Transport & {
  calls: Array<{
    base: SignalkBase;
    path: string;
    method: string;
    body?: string;
  }>;
};

function stubTransport(
  fn: (call: number, path: string, method: string) => Promise<JsonResponse>,
): TransportStub {
  const calls: TransportStub["calls"] = [];
  const stub = ((base, path, method, body) => {
    calls.push({ base, path, method, body });
    return fn(calls.length - 1, path, method);
  }) as TransportStub;
  stub.calls = calls;
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
      base: httpsBase,
      clientId: "test",
      description: "test",
    });
    assert.deepEqual(result, { kind: "cached", token: "cached-tok" });
  });

  it("returns kind=no-security on HTTP 404", async () => {
    const result = await beginTokenRequest({
      dataDir,
      base: httpsBase,
      clientId: "test",
      description: "test",
      transport: stubTransport(() =>
        Promise.resolve(json(404, { message: "security off" })),
      ),
    });
    assert.deepEqual(result, { kind: "no-security" });
  });

  it("returns kind=requests-disabled on HTTP 403", async () => {
    const result = await beginTokenRequest({
      dataDir,
      base: httpsBase,
      clientId: "test",
      description: "test",
      transport: stubTransport(() => Promise.resolve(json(403, {}))),
    });
    assert.deepEqual(result, { kind: "requests-disabled" });
  });

  it("returns kind=pending with the href when SK accepts the request", async () => {
    const result = await beginTokenRequest({
      dataDir,
      base: httpsBase,
      clientId: "test",
      description: "test",
      transport: stubTransport(() =>
        Promise.resolve(
          json(202, {
            state: "PENDING",
            requestId: "req-123",
            statusCode: 202,
            href: "/signalk/v1/requests/req-123",
          }),
        ),
      ),
    });
    assert.deepEqual(result, {
      kind: "pending",
      requestId: "req-123",
      href: "/signalk/v1/requests/req-123",
    });
  });

  it("caches the token and returns kind=cached when SK already has approval on file", async () => {
    const result = await beginTokenRequest({
      dataDir,
      base: httpsBase,
      clientId: "test",
      description: "test",
      transport: stubTransport(() =>
        Promise.resolve(
          json(200, {
            state: "COMPLETED",
            requestId: "req-abc",
            statusCode: 200,
            accessRequest: { permission: "APPROVED", token: JWT },
          }),
        ),
      ),
    });
    assert.deepEqual(result, { kind: "cached", token: JWT });
    assert.equal(readCachedToken(dataDir), JWT);
  });

  it("returns kind=error on network failure", async () => {
    const result = await beginTokenRequest({
      dataDir,
      base: httpsBase,
      clientId: "test",
      description: "test",
      transport: stubTransport(() =>
        Promise.reject(new Error("SELF_SIGNED_CERT_IN_CHAIN")),
      ),
    });
    assert.equal(result.kind, "error");
    if (result.kind === "error") {
      assert.ok(result.message.includes("SELF_SIGNED_CERT_IN_CHAIN"));
    }
  });

  it("posts over the resolved https base with clientId and permissions", async () => {
    const stub = stubTransport(() =>
      Promise.resolve(
        json(202, {
          state: "PENDING",
          requestId: "r",
          statusCode: 202,
          href: "/x",
        }),
      ),
    );
    await beginTokenRequest({
      dataDir,
      base: httpsBase,
      clientId: "grafana-test",
      description: "Grafana plugin test",
      permissions: "readwrite",
      transport: stub,
    });
    assert.equal(stub.calls[0].path, "/signalk/v1/access/requests");
    assert.equal(stub.calls[0].method, "POST");
    assert.deepEqual(stub.calls[0].base, httpsBase);
    const body = JSON.parse(stub.calls[0].body as string) as Record<
      string,
      string
    >;
    assert.equal(body.clientId, "grafana-test");
    assert.equal(body.permissions, "readwrite");
  });
});

describe("signalk-token: awaitApproval", () => {
  it("returns the token when the request transitions to COMPLETED with a token", async () => {
    const stub = stubTransport((call) =>
      call === 0
        ? Promise.resolve(json(200, { state: "PENDING", requestId: "r" }))
        : Promise.resolve(
            json(200, {
              state: "COMPLETED",
              requestId: "r",
              accessRequest: { permission: "APPROVED", token: JWT },
            }),
          ),
    );
    const token = await awaitApproval(
      "/signalk/v1/requests/r",
      httpsBase,
      () => false,
      () => {},
      5,
      stub,
    );
    assert.equal(token, JWT);
    assert.ok(stub.calls.length >= 2);
  });

  it("returns undefined when the admin denies (COMPLETED without a token)", async () => {
    const token = await awaitApproval(
      "/signalk/v1/requests/r",
      httpsBase,
      () => false,
      () => {},
      5,
      stubTransport(() =>
        Promise.resolve(
          json(200, {
            state: "COMPLETED",
            requestId: "r",
            accessRequest: { permission: "DENIED" },
          }),
        ),
      ),
    );
    assert.equal(token, undefined);
  });

  it("returns undefined when isCancelled becomes true mid-poll", async () => {
    let cancelled = false;
    setTimeout(() => {
      cancelled = true;
    }, 20);
    const token = await awaitApproval(
      "/signalk/v1/requests/r",
      httpsBase,
      () => cancelled,
      () => {},
      5,
      stubTransport(() =>
        Promise.resolve(json(200, { state: "PENDING", requestId: "r" })),
      ),
    );
    assert.equal(token, undefined);
  });

  it("polls the relative href path against the resolved base", async () => {
    const stub = stubTransport(() =>
      Promise.resolve(
        json(200, {
          state: "COMPLETED",
          requestId: "r",
          accessRequest: { token: JWT },
        }),
      ),
    );
    await awaitApproval(
      "/signalk/v1/requests/r",
      httpsBase,
      () => false,
      () => {},
      5,
      stub,
    );
    assert.equal(stub.calls[0].path, "/signalk/v1/requests/r");
    assert.deepEqual(stub.calls[0].base, httpsBase);
  });

  it("strips scheme/host from an absolute href and polls the resolved base", async () => {
    const stub = stubTransport(() =>
      Promise.resolve(
        json(200, {
          state: "COMPLETED",
          requestId: "r",
          accessRequest: { token: JWT },
        }),
      ),
    );
    await awaitApproval(
      "http://example:9999/signalk/v1/requests/r",
      httpsBase,
      () => false,
      () => {},
      5,
      stub,
    );
    assert.equal(stub.calls[0].path, "/signalk/v1/requests/r");
    assert.deepEqual(stub.calls[0].base, httpsBase);
  });
});
