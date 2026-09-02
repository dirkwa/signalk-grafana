import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SignalkEndpoint } from "./provisioning.js";

const DATASOURCE_HOST = "host.containers.internal";
const REQUEST_TIMEOUT_MS = 2000;
// Retry delays ride out the SK-boot gap between the http and https listeners.
const CONNECT_RETRY_DELAYS_MS = [0, 500, 1000, 2000];

// Cert errors that mean "reachable but untrusted" — drive the strict→lax fallback.
const CERT_ERROR_CODES = new Set([
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "CERT_HAS_EXPIRED",
]);

export interface GetResult {
  status: number;
  body: string;
  location?: string;
}

export interface GetError {
  code: string;
}

// Injectable so probe logic is testable without a live server. Each rejects
// with a GetError-shaped object ({ code }) on transport/TLS failure.
export interface ProbeTransports {
  httpGet: (port: number, path: string) => Promise<GetResult>;
  httpsGetStrict: (port: number, path: string) => Promise<GetResult>;
  httpsGetLax: (port: number, path: string) => Promise<GetResult>;
}

export interface ProbeOptions {
  httpPort: number;
  dataDir: string;
  transports?: ProbeTransports;
  log?: (msg: string) => void;
  sleep?: (ms: number) => Promise<void>;
  sslportHint?: number;
}

export interface ProbeResult {
  conclusive: boolean;
  scheme: "http" | "https";
  port: number;
  selfSigned: boolean;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// WHY PORT env wins: it reflects how the server was actually launched; the settings port covers env-less installs on nonstandard ports.
export function resolveProbeHttpPort(
  envPort: string | undefined,
  settingsPort: unknown,
): number {
  const isValidPort = (port: number) =>
    Number.isInteger(port) && port > 0 && port <= 65535;
  const fromEnv = Number(envPort);
  if (isValidPort(fromEnv)) return fromEnv;
  const fromSettings = Number(settingsPort);
  if (isValidPort(fromSettings)) return fromSettings;
  return 3000;
}

function isDiscoveryDoc(body: string): boolean {
  // SK's /signalk root returns an endpoints document; matching the literal
  // key avoids treating a captive-portal/200-OK page as a real SK server.
  return body.includes('"endpoints"') && body.includes('"server"');
}

function nodeGet(
  secure: boolean,
  rejectUnauthorized: boolean,
  port: number,
  path: string,
): Promise<GetResult> {
  return new Promise((resolve, reject) => {
    const req = (secure ? httpsRequest : httpRequest)(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "GET",
        // The datasource talks to DATASOURCE_HOST, never in the cert SAN —
        // setting servername keeps SNI honest without affecting the verdict.
        ...(secure ? { rejectUnauthorized, servername: DATASOURCE_HOST } : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c as Buffer));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
            location: res.headers.location,
          }),
        );
      },
    );
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy();
      reject({ code: "ETIMEDOUT" });
    });
    req.on("error", (err: NodeJS.ErrnoException) =>
      reject({ code: err.code ?? "EUNKNOWN" }),
    );
    req.end();
  });
}

// WHY node:http(s) not fetch: fetch auto-follows the 302 and masks the redirect,
// and rejectUnauthorized is only settable via node:https here.
export function realTransports(): ProbeTransports {
  return {
    httpGet: (port, path) => nodeGet(false, true, port, path),
    httpsGetStrict: (port, path) => nodeGet(true, true, port, path),
    httpsGetLax: (port, path) => nodeGet(true, false, port, path),
  };
}

function isGetError(e: unknown): e is GetError {
  return (
    typeof e === "object" &&
    e !== null &&
    typeof (e as { code?: unknown }).code === "string"
  );
}

function isCertError(code: string): boolean {
  return CERT_ERROR_CODES.has(code) || /CERT|SELF_SIGNED|ALTNAME/.test(code);
}

function locationPort(location: string | undefined): number | undefined {
  if (!location) return undefined;
  try {
    const parsed = new URL(location);
    if (parsed.protocol !== "https:") return undefined;
    // Empty URL.port (https default) normalizes to 443, never NaN.
    return parsed.port ? Number(parsed.port) : 443;
  } catch {
    return undefined;
  }
}

function readSslportFromSettings(dataDir: string): number | undefined {
  // WHY best-effort: SK's settings.json sits a couple levels above the plugin
  // data dir; a wrong/in-container path just falls through to the 443 default.
  const candidates = [
    join(dataDir, "..", "..", "settings.json"),
    join(dataDir, "..", "..", "..", "settings.json"),
  ];
  for (const path of candidates) {
    try {
      if (!existsSync(path)) continue;
      const parsed = JSON.parse(readFileSync(path, "utf8")) as {
        sslport?: unknown;
      };
      const sslport = Number(parsed.sslport);
      if (Number.isInteger(sslport) && sslport > 0) return sslport;
    } catch {
      // unreadable / not JSON — try the next candidate
    }
  }
  return undefined;
}

// Two-pass https GET: strict (clean cert), then lax on a cert error (untrusted
// but reachable); null when the port is not a reachable https endpoint.
async function confirmHttps(
  t: ProbeTransports,
  port: number,
): Promise<{ selfSigned: boolean } | null> {
  try {
    const res = await t.httpsGetStrict(port, "/signalk");
    if (res.status >= 200 && res.status < 300 && isDiscoveryDoc(res.body)) {
      return { selfSigned: false };
    }
  } catch (e) {
    if (!isGetError(e) || !isCertError(e.code)) return null;
  }
  try {
    const res = await t.httpsGetLax(port, "/signalk");
    if (res.status >= 200 && res.status < 300 && isDiscoveryDoc(res.body)) {
      return { selfSigned: true };
    }
  } catch {
    // not a usable https endpoint
  }
  return null;
}

export async function probeSignalkEndpoint(
  opts: ProbeOptions,
): Promise<ProbeResult> {
  const t = opts.transports ?? realTransports();
  const log = opts.log ?? (() => {});
  const sleep = opts.sleep ?? defaultSleep;
  const httpPort = opts.httpPort;

  let httpAttempt: GetResult | null = null;
  let redirectsToHttps = false;
  let locationHint: number | undefined;
  let httpsOnHttpPort = false;

  for (let i = 0; i < CONNECT_RETRY_DELAYS_MS.length; i++) {
    if (CONNECT_RETRY_DELAYS_MS[i] > 0) await sleep(CONNECT_RETRY_DELAYS_MS[i]);
    try {
      httpAttempt = await t.httpGet(httpPort, "/signalk");
      break;
    } catch (e) {
      const code = isGetError(e) ? e.code : "EUNKNOWN";
      // Plain GET hitting a TLS socket — SK is https on this very port.
      if (/EPROTO|ECONNRESET|WRONG_VERSION|SSL/.test(code)) {
        httpsOnHttpPort = true;
        break;
      }
      if (code === "ECONNREFUSED" || code === "ETIMEDOUT") {
        log(`Signal K probe: ${code} on http :${httpPort} (retry)`);
        continue;
      }
      log(`Signal K probe: unexpected ${code} on http :${httpPort}`);
      break;
    }
  }

  if (httpAttempt) {
    if (
      httpAttempt.status >= 200 &&
      httpAttempt.status < 300 &&
      isDiscoveryDoc(httpAttempt.body)
    ) {
      return {
        conclusive: true,
        scheme: "http",
        port: httpPort,
        selfSigned: false,
      };
    }
    if (httpAttempt.status >= 300 && httpAttempt.status < 400) {
      locationHint = locationPort(httpAttempt.location);
      redirectsToHttps = locationHint !== undefined;
    }
  }

  if (!redirectsToHttps && !httpsOnHttpPort) {
    log("Signal K probe: no https signal; leaving scheme as http");
    return {
      conclusive: false,
      scheme: "http",
      port: httpPort,
      selfSigned: false,
    };
  }

  // Confirm the https port. The redirect Location can point at SK's public
  // external port (proxy/sslport), which need not be reachable via
  // host.containers.internal, so every candidate is verified by an actual
  // discovery-doc fetch and we commit to the first that answers.
  const candidates: number[] = [];
  const pushCandidate = (p: number | undefined) => {
    if (p && Number.isInteger(p) && !candidates.includes(p)) candidates.push(p);
  };
  if (httpsOnHttpPort) pushCandidate(httpPort);
  pushCandidate(locationHint);
  pushCandidate(opts.sslportHint);
  pushCandidate(readSslportFromSettings(opts.dataDir));
  const envSslport = Number(process.env.SSLPORT);
  pushCandidate(Number.isInteger(envSslport) ? envSslport : undefined);
  pushCandidate(443);

  for (const port of candidates) {
    const confirmed = await confirmHttps(t, port);
    if (confirmed) {
      return {
        conclusive: true,
        scheme: "https",
        port,
        selfSigned: confirmed.selfSigned,
      };
    }
  }

  // Saw an https signal but couldn't confirm a reachable port. Don't silently
  // write http (that recreates the original bug); report inconclusive so the
  // caller can reuse the last-good endpoint and log a manual-override hint.
  log(
    `Signal K probe: detected https but no reachable port among ${candidates.join(", ")}`,
  );
  return {
    conclusive: false,
    scheme: "https",
    port: locationHint ?? 443,
    selfSigned: true,
  };
}

// Pure: turn a probe result into the datasource endpoint. On the auto path,
// https always pairs with tlsSkipVerify because the datasource host
// (host.containers.internal) is never in SK's cert SAN, so Grafana's strict
// verification can't pass regardless of CA trust.
export function probeResultToEndpoint(
  result: ProbeResult,
  lastGood?: SignalkEndpoint,
): SignalkEndpoint {
  if (!result.conclusive && lastGood) return lastGood;
  const ssl = result.scheme === "https";
  return {
    host: `${DATASOURCE_HOST}:${result.port}`,
    ssl,
    tlsSkipVerify: ssl,
  };
}
