import { describe, it, before, afterEach, type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { EventEmitter } from "events";
import type { Response } from "express";
import {
  _resetInflightForTesting,
  handleDashboardFile,
  handleDashboardManifest,
  handleDbExport,
  handleProvisioningFile,
  handleProvisioningManifest,
  type DbBackupFn,
  type ExportRequest,
} from "../full-export";

// Minimal request mock — handlers only read `req.params`, so we expose
// only that. `Response` is faked separately below.
function fakeReq(params: Record<string, string> = {}): ExportRequest {
  return { params };
}

// Stand-in for express.Response that captures what the handlers do.
// Declares the Writable surface (write/end) we need for `pipeline()`,
// so we don't paper over missing methods with per-property casts.
interface FakeRes extends EventEmitter {
  statusCode: number;
  headersSent: boolean;
  jsonBody: unknown;
  streamedChunks: Buffer[];
  destroyed: boolean;
  status: (code: number) => FakeRes;
  json: (body: unknown) => void;
  setHeader: (name: string, value: string) => void;
  destroy: () => void;
  write: (chunk: Buffer) => boolean;
  end: () => void;
}

// The handlers accept express.Response; FakeRes implements only the
// subset they touch (status / json / setHeader / destroy /
// headersSent + the Writable surface). One cast at construction
// keeps the test call-sites free of per-invocation casts.
function fakeRes(): FakeRes & Response {
  const res = new EventEmitter() as FakeRes;
  res.statusCode = 200;
  res.headersSent = false;
  res.jsonBody = undefined;
  res.streamedChunks = [];
  res.destroyed = false;
  res.status = (code: number) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body: unknown) => {
    res.jsonBody = body;
    res.headersSent = true;
  };
  res.setHeader = () => {};
  res.destroy = () => {
    res.destroyed = true;
  };
  // pipeline() pipes into a writable; emulate the writable surface.
  res.write = (chunk: Buffer) => {
    res.streamedChunks.push(chunk);
    res.headersSent = true;
    return true;
  };
  res.end = () => {
    res.emit("finish");
  };
  return res as FakeRes & Response;
}

describe("full-export — dashboard manifest", () => {
  let dataDir: string;
  afterEach(() => {
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  it("returns empty list when dashboards dir is missing", async () => {
    dataDir = mkdtempSync(join(tmpdir(), "grafana-fe-"));
    const res = fakeRes();
    await handleDashboardManifest(fakeReq(), res, {
      dataDir,
    });
    assert.deepEqual(res.jsonBody, { dashboards: [] });
  });

  it("lists dashboards with hash and size", async () => {
    dataDir = mkdtempSync(join(tmpdir(), "grafana-fe-"));
    mkdirSync(join(dataDir, "dashboards"));
    writeFileSync(join(dataDir, "dashboards", "navigation.json"), '{"a":1}');
    writeFileSync(
      join(dataDir, "dashboards", "electrical.json"),
      '{"b":2,"c":3}',
    );

    const res = fakeRes();
    await handleDashboardManifest(fakeReq(), res, {
      dataDir,
    });
    const body = res.jsonBody as { dashboards: Array<Record<string, unknown>> };
    assert.equal(body.dashboards.length, 2);
    // Sorted by name → electrical first.
    assert.equal(body.dashboards[0].name, "electrical.json");
    assert.equal(body.dashboards[0].bytes, 13);
    assert.match(body.dashboards[0].sha256 as string, /^[0-9a-f]{64}$/);
    assert.equal(body.dashboards[1].name, "navigation.json");
    assert.equal(body.dashboards[1].bytes, 7);
    // Flat dashboard listing — no relPath in the per-entry shape.
    assert.equal(
      (body.dashboards[0] as { relPath?: string }).relPath,
      undefined,
    );
  });

  it("skips nested dashboard files (flat manifest, flat fetch route)", async () => {
    // Without this guard the manifest would advertise a nested file by
    // its basename, but /dashboards/:name only accepts a single
    // segment so the client would 404 trying to fetch it. Skip the
    // subdir entirely.
    dataDir = mkdtempSync(join(tmpdir(), "grafana-fe-"));
    mkdirSync(join(dataDir, "dashboards", "archived"), { recursive: true });
    writeFileSync(join(dataDir, "dashboards", "top.json"), "{}");
    writeFileSync(
      join(dataDir, "dashboards", "archived", "old.json"),
      '{"old": true}',
    );

    const res = fakeRes();
    await handleDashboardManifest(fakeReq(), res, {
      dataDir,
    });
    const body = res.jsonBody as { dashboards: Array<Record<string, unknown>> };
    assert.equal(body.dashboards.length, 1);
    assert.equal(body.dashboards[0].name, "top.json");
  });
});

describe("full-export — dashboard file", () => {
  let dataDir: string;
  afterEach(() => {
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  it("rejects path traversal in :name", async () => {
    dataDir = mkdtempSync(join(tmpdir(), "grafana-fe-"));
    const res = fakeRes();
    await handleDashboardFile(fakeReq({ name: "../../../etc/passwd" }), res, {
      dataDir,
    });
    assert.equal(res.statusCode, 400);
  });

  it("rejects names with slashes", async () => {
    dataDir = mkdtempSync(join(tmpdir(), "grafana-fe-"));
    const res = fakeRes();
    await handleDashboardFile(fakeReq({ name: "subdir/foo.json" }), res, {
      dataDir,
    });
    assert.equal(res.statusCode, 400);
  });

  it("rejects bare '.' and '..' as dashboard name with a clean 400", async () => {
    // SAFE_FILENAME allows these as a side-effect of [._]; the handler
    // explicitly rejects them so the response is 400, not a confusing
    // 500 leaking 'path escapes root' from safeJoin.
    dataDir = mkdtempSync(join(tmpdir(), "grafana-fe-"));
    for (const name of [".", ".."]) {
      const res = fakeRes();
      await handleDashboardFile(fakeReq({ name }), res, { dataDir });
      assert.equal(res.statusCode, 400, `expected 400 for name="${name}"`);
    }
  });

  it("rejects symlinks even when their name passes validation", async (t: TestContext) => {
    // Defense in depth: safeJoin only verifies lexical containment, so
    // a symlink at <dashboards>/evil.json pointing outside the root
    // would otherwise be served via createReadStream.
    dataDir = mkdtempSync(join(tmpdir(), "grafana-fe-"));
    mkdirSync(join(dataDir, "dashboards"));
    const targetPath = join(tmpdir(), "grafana-fe-symlink-target");
    writeFileSync(targetPath, "secret content");
    try {
      symlinkSync(targetPath, join(dataDir, "dashboards", "evil.json"));
    } catch {
      // Some test environments (Windows runner) don't permit symlinks.
      // Mark the test as skipped so the report distinguishes "covered"
      // from "ran" — silently returning would look like a pass.
      t.skip("symlinks not supported on this platform");
      return;
    }

    const res = fakeRes();
    await handleDashboardFile(fakeReq({ name: "evil.json" }), res, {
      dataDir,
    });
    rmSync(targetPath, { force: true });
    assert.equal(res.statusCode, 400);
  });

  it("404s on a missing file even with safe name", async () => {
    dataDir = mkdtempSync(join(tmpdir(), "grafana-fe-"));
    mkdirSync(join(dataDir, "dashboards"));
    const res = fakeRes();
    await handleDashboardFile(fakeReq({ name: "missing.json" }), res, {
      dataDir,
    });
    assert.equal(res.statusCode, 404);
  });
});

describe("full-export — provisioning", () => {
  let dataDir: string;
  afterEach(() => {
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  it("manifest walks nested provisioning tree and reports relPath", async () => {
    dataDir = mkdtempSync(join(tmpdir(), "grafana-fe-"));
    mkdirSync(join(dataDir, "provisioning", "datasources"), {
      recursive: true,
    });
    mkdirSync(join(dataDir, "provisioning", "dashboards"), { recursive: true });
    writeFileSync(
      join(dataDir, "provisioning", "datasources", "questdb.yaml"),
      "apiVersion: 1\n",
    );
    writeFileSync(
      join(dataDir, "provisioning", "dashboards", "default.yaml"),
      "apiVersion: 1\n",
    );

    const res = fakeRes();
    await handleProvisioningManifest(fakeReq(), res, {
      dataDir,
    });
    const body = res.jsonBody as { files: Array<Record<string, unknown>> };
    assert.equal(body.files.length, 2);
    // Sort key is relPath here; dashboards/ < datasources/ alphabetically.
    assert.equal(body.files[0].relPath, "dashboards/default.yaml");
    assert.equal(body.files[1].relPath, "datasources/questdb.yaml");
  });

  it("rejects encoded path traversal in :relPath", async () => {
    dataDir = mkdtempSync(join(tmpdir(), "grafana-fe-"));
    const res = fakeRes();
    await handleProvisioningFile(
      fakeReq({ relPath: encodeURIComponent("../etc/passwd") }),
      res,
      { dataDir },
    );
    assert.equal(res.statusCode, 400);
  });

  it("rejects single-dot segments", async () => {
    dataDir = mkdtempSync(join(tmpdir(), "grafana-fe-"));
    const res = fakeRes();
    await handleProvisioningFile(
      fakeReq({ relPath: encodeURIComponent("./datasources/x.yaml") }),
      res,
      { dataDir },
    );
    assert.equal(res.statusCode, 400);
  });

  it("allows nested safe paths and serves the file", async () => {
    dataDir = mkdtempSync(join(tmpdir(), "grafana-fe-"));
    const yamlPath = join(dataDir, "provisioning", "datasources", "ok.yaml");
    mkdirSync(join(dataDir, "provisioning", "datasources"), {
      recursive: true,
    });
    writeFileSync(yamlPath, "apiVersion: 1\n");

    const res = fakeRes();
    // `handleProvisioningFile` awaits the pipeline internally, so by
    // the time this returns all bytes are already in streamedChunks
    // via our synchronous fake `write`.
    await handleProvisioningFile(
      fakeReq({
        relPath: encodeURIComponent("datasources/ok.yaml"),
      }),
      res,
      { dataDir },
    );
    const streamed = Buffer.concat(res.streamedChunks).toString("utf-8");
    assert.equal(streamed, "apiVersion: 1\n");
  });
});

describe("full-export — DB checkpoint lock", () => {
  let dataDir: string;
  before(() => _resetInflightForTesting());
  afterEach(() => {
    _resetInflightForTesting();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  it("coalesces concurrent checkpoint requests onto one backup() call", async () => {
    dataDir = mkdtempSync(join(tmpdir(), "grafana-fe-"));
    const backupDir = join(dataDir, "grafana-data", ".signalk-backup");
    mkdirSync(backupDir, { recursive: true });
    const checkpointPath = join(backupDir, "grafana-backup.db");

    let backupCalls = 0;
    let resolveBackup: () => void = () => {};
    const backupGate = new Promise<void>((r) => {
      resolveBackup = r;
    });
    const dbBackup: DbBackupFn = async (_src, dest) => {
      backupCalls++;
      // Hold the first call open until the second is queued so we
      // can prove the lock coalesces them.
      await backupGate;
      writeFileSync(dest, "SQLite-pretend-bytes");
    };

    const res1 = fakeRes();
    const res2 = fakeRes();
    // The handler's coalesce check (`if (!inflightDbExport)`) runs
    // synchronously before any `await`. Issuing both calls back-to-
    // back means `p2` sees the inflight promise `p1` created — no
    // sleep needed to "let it queue".
    const p1 = handleDbExport(fakeReq(), res1, { dataDir, dbBackup });
    const p2 = handleDbExport(fakeReq(), res2, { dataDir, dbBackup });
    resolveBackup();
    await Promise.all([p1, p2]);

    assert.equal(
      backupCalls,
      1,
      "second concurrent request should reuse the inflight checkpoint",
    );
    // Sanity-check that both responses still saw the file.
    assert.equal(statSync(checkpointPath).isFile(), true);
  });

  it("does not unlink the checkpoint file after streaming (next cycle cleans up)", async () => {
    // Earlier versions of the handler unlinked the checkpoint in
    // `finally`, which created a race when concurrent requests
    // crossed a generation boundary. We now leave the file alone and
    // rely on runCheckpoint's `unlink` at the start of each export.
    // Verify the file is still on disk after a successful export.
    dataDir = mkdtempSync(join(tmpdir(), "grafana-fe-"));
    const backupDir = join(dataDir, "grafana-data", ".signalk-backup");
    mkdirSync(backupDir, { recursive: true });
    const checkpointPath = join(backupDir, "grafana-backup.db");

    const dbBackup: DbBackupFn = async (_src, dest) => {
      writeFileSync(dest, "SQLite-pretend-bytes");
    };
    const res = fakeRes();
    await handleDbExport(fakeReq(), res, { dataDir, dbBackup });

    // pipeline finished — file should still exist.
    const st = statSync(checkpointPath);
    assert.equal(st.isFile(), true);
  });
});
