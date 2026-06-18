import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

const TOKEN_FILENAME = "signalk-token";
const POLL_INTERVAL_MS = 5_000;

export type EnsureResult =
  | { kind: "cached"; token: string }
  | { kind: "no-security" }
  | { kind: "requests-disabled" }
  | { kind: "pending"; requestId: string; href: string }
  | { kind: "error"; message: string };

// The plugin reaches SK over the same scheme/port the datasource probe
// resolved. On a TLS server the http port 302-redirects to https, and a plain
// fetch would either GET-on-redirect or fail on the self-signed loopback cert —
// which silently aborted the token flow. node:https.request with
// rejectUnauthorized:false (undici's Agent isn't requireable for fetch here)
// talks to the resolved endpoint directly, no redirect, no cert failure.
export interface SignalkBase {
  scheme: "http" | "https";
  port: number;
  tlsSkipVerify: boolean;
}

export interface EnsureOptions {
  dataDir: string;
  base: SignalkBase;
  clientId: string;
  description: string;
  permissions?: "readonly" | "readwrite" | "admin";
  transport?: Transport;
}

export interface JsonResponse {
  status: number;
  body: string;
}

// Injectable so the request/poll logic is testable without a live server.
export type Transport = (
  base: SignalkBase,
  path: string,
  method: "GET" | "POST",
  body?: string,
) => Promise<JsonResponse>;

const realTransport: Transport = (base, path, method, body) => {
  const secure = base.scheme === "https";
  return new Promise((resolve, reject) => {
    const req = (secure ? httpsRequest : httpRequest)(
      {
        host: "127.0.0.1",
        port: base.port,
        path,
        method,
        headers: {
          "Content-Type": "application/json",
          ...(body ? { "Content-Length": Buffer.byteLength(body) } : {}),
        },
        ...(secure ? { rejectUnauthorized: !base.tlsSkipVerify } : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c as Buffer));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
};

export function readCachedToken(dataDir: string): string | undefined {
  const path = join(dataDir, TOKEN_FILENAME);
  if (!existsSync(path)) return undefined;
  const raw = readFileSync(path, "utf8").trim();
  return raw.length > 0 ? raw : undefined;
}

export function tokenFilePath(dataDir: string): string {
  return join(dataDir, TOKEN_FILENAME);
}

export function hasCachedToken(dataDir: string): boolean {
  return existsSync(join(dataDir, TOKEN_FILENAME));
}

// Mode 0600 keeps the secret readable only to the SK server process owner.
export function writeCachedToken(dataDir: string, token: string): void {
  const path = join(dataDir, TOKEN_FILENAME);
  writeFileSync(path, token, { mode: 0o600 });
}

interface AccessRequestReply {
  state: "PENDING" | "COMPLETED";
  requestId: string;
  statusCode: number;
  href?: string;
  message?: string;
  accessRequest?: { permission?: string; token?: string };
}

export async function beginTokenRequest(
  opts: EnsureOptions,
): Promise<EnsureResult> {
  const cached = readCachedToken(opts.dataDir);
  if (cached) return { kind: "cached", token: cached };

  const transport = opts.transport ?? realTransport;
  const path = "/signalk/v1/access/requests";
  let res: JsonResponse;
  try {
    res = await transport(
      opts.base,
      path,
      "POST",
      JSON.stringify({
        clientId: opts.clientId,
        description: opts.description,
        // Future Grafana-alerting → SK-notification paths need write;
        // SK admin UI can't widen permissions post-approval, so we ask
        // broadly up front instead of forcing a revoke/re-request later.
        permissions: opts.permissions ?? "readwrite",
      }),
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { kind: "error", message: `POST ${path} failed: ${msg}` };
  }

  if (res.status === 404) {
    // SK serves 404 here only when the dummy (no-security) strategy is
    // active. Tokens are neither minted nor needed.
    return { kind: "no-security" };
  }
  if (res.status === 403) {
    return { kind: "requests-disabled" };
  }
  if (res.status !== 202 && res.status !== 200) {
    return {
      kind: "error",
      message: `Unexpected HTTP ${res.status} from access-request endpoint`,
    };
  }

  const reply = JSON.parse(res.body) as AccessRequestReply;
  if (reply.state === "COMPLETED") {
    // Unusual but possible — approval already on file. Cache + return.
    const token = reply.accessRequest?.token;
    if (token) {
      writeCachedToken(opts.dataDir, token);
      return { kind: "cached", token };
    }
    return {
      kind: "error",
      message: "Access request completed without a token",
    };
  }
  if (!reply.href) {
    return { kind: "error", message: "Access request response missing href" };
  }

  // The polling loop lives in `awaitApproval` so the caller can race it
  // against its own shutdown signal (typically the plugin's stop()).
  return {
    kind: "pending",
    requestId: reply.requestId,
    href: reply.href,
  };
}

// pollIntervalMs defaults to 5s — admin approval is human-paced; tests
// override to single-digit ms.
export async function awaitApproval(
  href: string,
  base: SignalkBase,
  isCancelled: () => boolean,
  log: (msg: string) => void,
  pollIntervalMs: number = POLL_INTERVAL_MS,
  transport: Transport = realTransport,
): Promise<string | undefined> {
  // href from SK may be absolute (legacy) or a relative path; strip any scheme
  // and host so the poll always uses the resolved loopback base.
  const path = href.startsWith("http")
    ? new URL(href).pathname
    : `${href.startsWith("/") ? "" : "/"}${href}`;

  while (!isCancelled()) {
    await sleep(pollIntervalMs);
    if (isCancelled()) return undefined;

    let res: JsonResponse;
    try {
      res = await transport(base, path, "GET");
    } catch (err) {
      log(
        `Token poll fetch failed (will retry): ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    if (res.status < 200 || res.status >= 300) {
      log(`Token poll: HTTP ${res.status} (will retry)`);
      continue;
    }
    const reply = JSON.parse(res.body) as AccessRequestReply;
    if (reply.state === "PENDING") {
      continue;
    }
    // COMPLETED. Either an approved request (has token) or a denied one.
    const token = reply.accessRequest?.token;
    if (token) return token;

    const perm = reply.accessRequest?.permission;
    log(
      `Access request completed without a token (permission=${perm ?? "unknown"}). ` +
        `Admin probably denied the request.`,
    );
    return undefined;
  }
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
