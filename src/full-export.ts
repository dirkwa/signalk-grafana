import type { Response } from "express";
import { createReadStream } from "fs";
import { readdir, stat, unlink } from "fs/promises";
import { createHash } from "crypto";
import { join, normalize, relative, sep } from "path";
import { pipeline } from "stream/promises";

// Narrow request shape — handlers read only `req.params`. Typing it
// this way lets tests pass plain `{ params: {...} }` objects without
// `as never` casts.
export interface ExportRequest {
  params: Record<string, string | string[] | undefined>;
}

// signalk-backup pulls these endpoints over loopback HTTP; this module
// gives it a consistent SQLite checkpoint of grafana.db plus the
// dashboard JSONs and provisioning YAMLs. Mirrors the signalk-questdb
// export pattern so signalk-backup can treat both plugins uniformly.

const CONTAINER_NAME = "signalk-grafana";
// `/var/lib/grafana` is bind-mounted to `<dataDir>/grafana-data` (see
// src/index.ts where the container config is built). Writing the
// checkpoint inside this dir lets us read it on the host without
// piping the file through `cat | base64` over `exec`.
const CHECKPOINT_DIR_IN_CONTAINER = "/var/lib/grafana/.signalk-backup";
const CHECKPOINT_FILE = "grafana-backup.db";
// Path inside the dataDir hierarchy on the host. Resolved at call
// time because dataDir is plugin-instance-scoped.
const CHECKPOINT_HOST_SUBPATH = join(
  "grafana-data",
  ".signalk-backup",
  CHECKPOINT_FILE,
);

// Dashboard files live under <dataDir>/dashboards/ and are flat JSON
// files (one dashboard per file). Provisioning lives under
// <dataDir>/provisioning/ with `datasources/` and `dashboards/`
// subdirectories of YAML.
const DASHBOARDS_SUBDIR = "dashboards";
const PROVISIONING_SUBDIR = "provisioning";

// File names are validated against this pattern before being used in
// a filesystem read. Allow letters / digits / dot / dash / underscore;
// disallow anything that could escape the directory or hide intent.
const SAFE_FILENAME = /^[a-zA-Z0-9._-]+$/;

export type ExecFn = (
  name: string,
  command: string[],
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

export interface FullExportDeps {
  dataDir: string;
  containerName?: string;
  exec: ExecFn;
  log?: (msg: string) => void;
}

// Coalesce concurrent DB-export requests onto a single sqlite3 .backup
// and synchronize cleanup so the file lives long enough for every
// piggybacking reader to consume it. Without coalescing, a periodic
// scheduler firing at the same moment as a manual export would race
// on the same checkpoint file. Without reader counting, the first
// finisher would unlink the file out from under the second reader
// (the second reader's createReadStream would hit ENOENT).
let inflightDbExport: Promise<void> | null = null;
let inflightReaders = 0;

function defaultLog(msg: string): void {
  console.error(`[full-export] ${msg}`);
}

function sendError(res: Response, status: number, message: string): void {
  if (res.headersSent) {
    // Stream already started — best we can do is destroy the response.
    res.destroy();
    return;
  }
  res.status(status).json({ error: message });
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

// Resolve a host path inside a known root, refusing anything that
// escapes via `..` or absolute paths. Returns the resolved path on
// success, throws otherwise.
function safeJoin(root: string, ...parts: string[]): string {
  const candidate = normalize(join(root, ...parts));
  const rel = relative(root, candidate);
  if (rel.startsWith("..") || rel.startsWith(sep) || rel === "") {
    throw new Error(`path escapes root: ${parts.join("/")}`);
  }
  return candidate;
}

async function runCheckpoint(deps: FullExportDeps): Promise<string> {
  const containerName = deps.containerName ?? CONTAINER_NAME;
  const log = deps.log ?? defaultLog;
  const hostPath = join(deps.dataDir, CHECKPOINT_HOST_SUBPATH);
  const containerPath = `${CHECKPOINT_DIR_IN_CONTAINER}/${CHECKPOINT_FILE}`;

  await deps.exec(containerName, ["mkdir", "-p", CHECKPOINT_DIR_IN_CONTAINER]);
  // Drop any previous checkpoint first — `sqlite3 .backup` overwrites,
  // but leaving stale bytes around on failure would mask the error.
  await deps.exec(containerName, ["rm", "-f", containerPath]);

  const result = await deps.exec(containerName, [
    "sqlite3",
    "/var/lib/grafana/grafana.db",
    `.backup ${containerPath}`,
  ]);
  if (result.exitCode !== 0) {
    throw new Error(
      `sqlite3 .backup failed (exit ${result.exitCode}): ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }

  // Confirm the checkpoint file is reachable on the host. If the bind
  // mount isn't shaped as we expect, this is where we'll catch it
  // before streaming a 0-byte file.
  const st = await stat(hostPath);
  if (st.size === 0) {
    throw new Error(`checkpoint produced an empty file at ${hostPath}`);
  }
  log(`wrote SQLite checkpoint: ${st.size} bytes`);
  return hostPath;
}

export async function handleDbExport(
  _req: ExportRequest,
  res: Response,
  deps: FullExportDeps,
): Promise<void> {
  // Coalesce: piggyback on any in-flight checkpoint AND keep the
  // checkpoint file alive until the last coalesced reader finishes
  // streaming it. Increment before the await so a request arriving
  // during another request's streaming phase still pins the file.
  inflightReaders++;
  if (!inflightDbExport) {
    inflightDbExport = runCheckpoint(deps).then(() => undefined);
  }

  let hostPath: string;
  try {
    await inflightDbExport;
    hostPath = join(deps.dataDir, CHECKPOINT_HOST_SUBPATH);
  } catch (err) {
    sendError(
      res,
      500,
      err instanceof Error ? err.message : "checkpoint failed",
    );
    await releaseReader(null);
    return;
  }

  res.setHeader("content-type", "application/octet-stream");
  try {
    await pipeline(createReadStream(hostPath), res);
  } catch (err) {
    (deps.log ?? defaultLog)(
      `stream failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    // Response is already in-flight; can't change status. The client
    // sees a truncated body and treats it as a failed download.
  } finally {
    await releaseReader(hostPath);
  }
}

// Drop the in-flight reader count by one; when the last reader leaves,
// clear the inflight slot so the next request triggers a fresh
// checkpoint and unlink the checkpoint file if we have one. Cleanup
// is best-effort — a leftover file under .signalk-backup/ is harmless
// (next export's `rm -f` clears it) and we never want to surface an
// unlink error to a successfully-streamed response.
async function releaseReader(hostPath: string | null): Promise<void> {
  inflightReaders--;
  if (inflightReaders > 0) return;
  inflightDbExport = null;
  if (hostPath) await unlink(hostPath).catch(() => undefined);
}

interface ManifestEntry {
  name: string;
  relPath?: string;
  sha256: string;
  bytes: number;
}

async function buildManifest(
  root: string,
  keepRelPath: boolean,
): Promise<ManifestEntry[]> {
  const out: ManifestEntry[] = [];

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      // Missing root just means the user hasn't generated anything
      // there yet (e.g. fresh install). Empty manifest is the right
      // response, not a 500.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const st = await stat(full);
      const hash = await sha256File(full);
      const rel = relative(root, full);
      out.push({
        name: entry.name,
        // `relPath` is only meaningful for the provisioning tree
        // which has subdirectories. Dashboards is flat, so we omit it
        // to keep the manifest shape obvious.
        ...(keepRelPath ? { relPath: rel } : {}),
        sha256: hash,
        bytes: st.size,
      });
    }
  }

  await walk(root);
  // Sort for deterministic output — kopia dedup loves byte-stable.
  out.sort((a, b) => (a.relPath ?? a.name).localeCompare(b.relPath ?? b.name));
  return out;
}

export async function handleDashboardManifest(
  _req: ExportRequest,
  res: Response,
  deps: FullExportDeps,
): Promise<void> {
  try {
    const root = join(deps.dataDir, DASHBOARDS_SUBDIR);
    const dashboards = await buildManifest(root, false);
    res.json({ dashboards });
  } catch (err) {
    sendError(
      res,
      500,
      err instanceof Error ? err.message : "manifest build failed",
    );
  }
}

export async function handleDashboardFile(
  req: ExportRequest,
  res: Response,
  deps: FullExportDeps,
): Promise<void> {
  const rawName = req.params.name;
  const name = typeof rawName === "string" ? rawName : "";
  if (!SAFE_FILENAME.test(name)) {
    sendError(res, 400, "invalid dashboard name");
    return;
  }
  try {
    const root = join(deps.dataDir, DASHBOARDS_SUBDIR);
    const filePath = safeJoin(root, name);
    const st = await stat(filePath);
    if (!st.isFile()) {
      sendError(res, 404, "not a file");
      return;
    }
    res.setHeader("content-type", "application/json");
    await pipeline(createReadStream(filePath), res);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      sendError(res, 404, "dashboard not found");
      return;
    }
    sendError(res, 500, err instanceof Error ? err.message : "stream failed");
  }
}

export async function handleProvisioningManifest(
  _req: ExportRequest,
  res: Response,
  deps: FullExportDeps,
): Promise<void> {
  try {
    const root = join(deps.dataDir, PROVISIONING_SUBDIR);
    const files = await buildManifest(root, true);
    res.json({ files });
  } catch (err) {
    sendError(
      res,
      500,
      err instanceof Error ? err.message : "manifest build failed",
    );
  }
}

export async function handleProvisioningFile(
  req: ExportRequest,
  res: Response,
  deps: FullExportDeps,
): Promise<void> {
  // Express collapses path params on a single `:relPath` segment; the
  // signalk-backup side url-encodes the slashes. Decode here and then
  // run safeJoin to refuse anything that escapes the provisioning
  // root. Reject any segment containing `..` even before joining.
  const rawRelPath = req.params.relPath;
  const encoded = typeof rawRelPath === "string" ? rawRelPath : "";
  let decoded: string;
  try {
    decoded = decodeURIComponent(encoded);
  } catch {
    sendError(res, 400, "invalid path encoding");
    return;
  }
  const segments = decoded.split("/").filter(Boolean);
  if (segments.length === 0 || segments.some((s) => s === ".." || s === ".")) {
    sendError(res, 400, "invalid provisioning path");
    return;
  }
  for (const segment of segments) {
    if (!SAFE_FILENAME.test(segment)) {
      sendError(res, 400, "invalid provisioning path");
      return;
    }
  }

  try {
    const root = join(deps.dataDir, PROVISIONING_SUBDIR);
    const filePath = safeJoin(root, ...segments);
    const st = await stat(filePath);
    if (!st.isFile()) {
      sendError(res, 404, "not a file");
      return;
    }
    // YAML — content-type is more about "give me bytes" than format
    // detection on the consumer side, so use text/yaml for clarity.
    res.setHeader("content-type", "text/yaml");
    await pipeline(createReadStream(filePath), res);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      sendError(res, 404, "file not found");
      return;
    }
    sendError(res, 500, err instanceof Error ? err.message : "stream failed");
  }
}

// Test-only escape hatch so the in-process lock can be reset between
// test cases. Exported with a leading underscore to flag intent.
export function _resetInflightForTesting(): void {
  inflightDbExport = null;
  inflightReaders = 0;
}
