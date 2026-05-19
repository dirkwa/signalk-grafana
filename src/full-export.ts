import type { Response } from "express";
import { createReadStream } from "fs";
import { lstat, mkdir, readdir, stat, unlink } from "fs/promises";
import { createHash } from "crypto";
import { join, normalize, relative, sep } from "path";
import { pipeline } from "stream/promises";
import { DatabaseSync, backup } from "node:sqlite";

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

// `/var/lib/grafana` is bind-mounted to `<dataDir>/grafana-data` (see
// src/index.ts where the container config is built). Both the live DB
// and the checkpoint live under that subtree so the plugin can reach
// them with plain fs APIs.
const GRAFANA_DATA_SUBDIR = "grafana-data";
const CHECKPOINT_SUBDIR = ".signalk-backup";
const CHECKPOINT_FILE = "grafana-backup.db";
const GRAFANA_DB_FILENAME = "grafana.db";
const CHECKPOINT_HOST_SUBPATH = join(
  GRAFANA_DATA_SUBDIR,
  CHECKPOINT_SUBDIR,
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

// Online-backup hook. Defaults to node:sqlite's `backup()` against the
// bind-mounted grafana.db; tests inject a gated stub to exercise the
// coalesce/race logic without touching disk.
export type DbBackupFn = (
  sourcePath: string,
  destPath: string,
) => Promise<void>;

export interface FullExportDeps {
  dataDir: string;
  dbBackup?: DbBackupFn;
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

async function defaultDbBackup(
  sourcePath: string,
  destPath: string,
): Promise<void> {
  const src = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    await backup(src, destPath);
  } finally {
    src.close();
  }
}

async function runCheckpoint(deps: FullExportDeps): Promise<string> {
  const log = deps.log ?? defaultLog;
  const sourcePath = join(
    deps.dataDir,
    GRAFANA_DATA_SUBDIR,
    GRAFANA_DB_FILENAME,
  );
  const hostPath = join(deps.dataDir, CHECKPOINT_HOST_SUBPATH);
  const dbBackup = deps.dbBackup ?? defaultDbBackup;

  await mkdir(join(deps.dataDir, GRAFANA_DATA_SUBDIR, CHECKPOINT_SUBDIR), {
    recursive: true,
  });
  // Drop any previous checkpoint first — node:sqlite backup() overwrites
  // an existing file, but leaving stale bytes around on failure would
  // mask the error.
  await unlink(hostPath).catch(() => {});

  await dbBackup(sourcePath, hostPath);

  // Sanity-check the checkpoint is a real SQLite file before we stream
  // it. A 0-byte file shouldn't be possible with node:sqlite backup()
  // succeeding, but cheap to verify and gives a clearer error than the
  // client seeing a truncated body.
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
    await releaseReader();
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
    await releaseReader();
  }
}

// Drop the in-flight reader count by one; when the last reader leaves,
// clear the inflight slot so the next request triggers a fresh
// checkpoint.
//
// We deliberately do NOT unlink the checkpoint file here. The previous
// version did, and CR caught the race: clearing `inflightDbExport`
// before `await unlink` lets a new request start a fresh checkpoint
// at the same hostPath, and the still-pending unlink from the old
// generation can then delete the new file out from under it.
// Reversing the order doesn't help either (it just shifts the race).
// Generation-unique filenames would also work but add plumbing.
//
// Instead we rely on `runCheckpoint` clearing the file at the start
// of every export via `unlink`. The leftover sits under
// `<dataDir>/grafana-data/.signalk-backup/grafana-backup.db` — a
// hidden subdir of an already-private bind mount, ~MB scale, owned
// by the SignalK user — until the next scheduled export overwrites
// it. Worst-case crash-before-next-export leaves one stale file there.
async function releaseReader(): Promise<void> {
  inflightReaders--;
  if (inflightReaders > 0) return;
  inflightDbExport = null;
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
        // Skip subdirectories entirely in flat mode (dashboards). Without
        // this, a nested file would be advertised in the manifest by its
        // basename only — but `/dashboards/:name` only accepts a single
        // segment, so the client couldn't fetch it. Recursive walks stay
        // enabled for provisioning where the per-file endpoint accepts
        // an encoded relPath.
        if (keepRelPath) await walk(full);
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
  // SAFE_FILENAME allows `.` and `..` as a side-effect of `[a-zA-Z0-9._-]+`,
  // so reject them explicitly. Without this they'd hit safeJoin and produce
  // a 500 with a "path escapes root" message that leaks an internal detail
  // (and is the wrong status — the input is malformed, not the runtime).
  if (name === "." || name === ".." || !SAFE_FILENAME.test(name)) {
    sendError(res, 400, "invalid dashboard name");
    return;
  }
  try {
    const root = join(deps.dataDir, DASHBOARDS_SUBDIR);
    const filePath = safeJoin(root, name);
    // lstat (not stat) so we see the symlink itself rather than its
    // target. Refusing symlinks closes the "plant a symlink inside
    // /dashboards pointing to /etc/passwd" hole — safeJoin only does
    // lexical containment so it can't detect that on its own.
    const st = await lstat(filePath);
    if (st.isSymbolicLink()) {
      sendError(res, 400, "symlink rejected");
      return;
    }
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
    // Same lstat-rejects-symlinks hardening as the dashboard handler.
    const st = await lstat(filePath);
    if (st.isSymbolicLink()) {
      sendError(res, 400, "symlink rejected");
      return;
    }
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
