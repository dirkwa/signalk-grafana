import { describe, it, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { EventEmitter } from "events";
import {
  _resetInflightForTesting,
  handleDashboardFile,
  handleDashboardManifest,
  handleDbExport,
  handleProvisioningFile,
  handleProvisioningManifest,
  type ExecFn,
} from "../full-export";

// Minimal Request/Response stand-ins. Express plays fast and loose
// with types; the handlers only touch the surface we expose here.
function fakeReq(params: Record<string, string> = {}): unknown {
  return { params };
}

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
}

function fakeRes(): FakeRes {
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
  (res as unknown as { write: (chunk: Buffer) => boolean }).write = (
    chunk: Buffer,
  ) => {
    res.streamedChunks.push(chunk);
    res.headersSent = true;
    return true;
  };
  (res as unknown as { end: () => void }).end = () => {
    res.emit("finish");
  };
  // For `await pipeline(...)` to resolve, the writable needs `on()`
  // (EventEmitter already gives us that) and `once('finish' / 'close')`.
  return res;
}

describe("full-export — dashboard manifest", () => {
  let dataDir: string;
  afterEach(() => {
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  it("returns empty list when dashboards dir is missing", async () => {
    dataDir = mkdtempSync(join(tmpdir(), "grafana-fe-"));
    const res = fakeRes();
    await handleDashboardManifest(fakeReq() as never, res as never, {
      dataDir,
      exec: noopExec,
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
    await handleDashboardManifest(fakeReq() as never, res as never, {
      dataDir,
      exec: noopExec,
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
});

describe("full-export — dashboard file", () => {
  let dataDir: string;
  afterEach(() => {
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  it("rejects path traversal in :name", async () => {
    dataDir = mkdtempSync(join(tmpdir(), "grafana-fe-"));
    const res = fakeRes();
    await handleDashboardFile(
      fakeReq({ name: "../../../etc/passwd" }) as never,
      res as never,
      { dataDir, exec: noopExec },
    );
    assert.equal(res.statusCode, 400);
  });

  it("rejects names with slashes", async () => {
    dataDir = mkdtempSync(join(tmpdir(), "grafana-fe-"));
    const res = fakeRes();
    await handleDashboardFile(
      fakeReq({ name: "subdir/foo.json" }) as never,
      res as never,
      { dataDir, exec: noopExec },
    );
    assert.equal(res.statusCode, 400);
  });

  it("404s on a missing file even with safe name", async () => {
    dataDir = mkdtempSync(join(tmpdir(), "grafana-fe-"));
    mkdirSync(join(dataDir, "dashboards"));
    const res = fakeRes();
    await handleDashboardFile(
      fakeReq({ name: "missing.json" }) as never,
      res as never,
      { dataDir, exec: noopExec },
    );
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
    await handleProvisioningManifest(fakeReq() as never, res as never, {
      dataDir,
      exec: noopExec,
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
      fakeReq({ relPath: encodeURIComponent("../etc/passwd") }) as never,
      res as never,
      { dataDir, exec: noopExec },
    );
    assert.equal(res.statusCode, 400);
  });

  it("rejects single-dot segments", async () => {
    dataDir = mkdtempSync(join(tmpdir(), "grafana-fe-"));
    const res = fakeRes();
    await handleProvisioningFile(
      fakeReq({ relPath: encodeURIComponent("./datasources/x.yaml") }) as never,
      res as never,
      { dataDir, exec: noopExec },
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
      }) as never,
      res as never,
      { dataDir, exec: noopExec },
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

  it("coalesces concurrent checkpoint requests onto one exec sequence", async () => {
    dataDir = mkdtempSync(join(tmpdir(), "grafana-fe-"));
    const backupDir = join(dataDir, "grafana-data", ".signalk-backup");
    mkdirSync(backupDir, { recursive: true });
    const checkpointPath = join(backupDir, "grafana-backup.db");
    writeFileSync(checkpointPath, "SQLite-pretend-bytes");

    let backupCalls = 0;
    let resolveBackup: () => void = () => {};
    const backupGate = new Promise<void>((r) => {
      resolveBackup = r;
    });
    const exec: ExecFn = async (_name, cmd) => {
      if (cmd.includes("mkdir") || cmd.includes("rm")) {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (cmd[0] === "sqlite3") {
        backupCalls++;
        // Hold the first call open until the second is queued so we
        // can prove the lock coalesces them.
        await backupGate;
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const res1 = fakeRes();
    const res2 = fakeRes();
    // The handler's coalesce check (`if (!inflightDbExport)`) runs
    // synchronously before any `await`. Issuing both calls back-to-
    // back means `p2` sees the inflight promise `p1` created — no
    // sleep needed to "let it queue".
    const p1 = handleDbExport(fakeReq() as never, res1 as never, {
      dataDir,
      exec,
    });
    const p2 = handleDbExport(fakeReq() as never, res2 as never, {
      dataDir,
      exec,
    });
    resolveBackup();
    await Promise.all([p1, p2]);

    assert.equal(
      backupCalls,
      1,
      "second concurrent request should reuse the inflight checkpoint",
    );
  });
});

const noopExec: ExecFn = async () => ({
  exitCode: 0,
  stdout: "",
  stderr: "",
});
