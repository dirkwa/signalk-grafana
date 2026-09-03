import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { rehydrateFromBackup } from "../rehydrate.js";

// Builds the `<configRoot>/plugin-config-data/{signalk-grafana, signalk-backup}`
// layout that rehydrate expects, returns the path the function takes as
// `dataDir` (the signalk-grafana plugin's data dir).
function makeFixture(opts: { staged?: Buffer; live?: Buffer } = {}): {
  root: string;
  dataDir: string;
  liveDb: string;
  stagedDb: string;
} {
  const root = mkdtempSync(join(tmpdir(), "grafana-rehydrate-"));
  const pluginConfigData = join(root, "plugin-config-data");
  const dataDir = join(pluginConfigData, "signalk-grafana");
  const liveDb = join(dataDir, "grafana-data", "grafana.db");
  const stagedDb = join(
    pluginConfigData,
    "signalk-backup",
    "database-exports",
    "signalk-grafana",
    "grafana.db",
  );

  mkdirSync(dataDir, { recursive: true });
  if (opts.live) {
    mkdirSync(join(dataDir, "grafana-data"), { recursive: true });
    writeFileSync(liveDb, opts.live);
  }
  if (opts.staged) {
    mkdirSync(
      join(
        pluginConfigData,
        "signalk-backup",
        "database-exports",
        "signalk-grafana",
      ),
      {
        recursive: true,
      },
    );
    writeFileSync(stagedDb, opts.staged);
  }
  return { root, dataDir, liveDb, stagedDb };
}

describe("rehydrateFromBackup", () => {
  let cleanup: Array<() => void> = [];
  afterEach(() => {
    for (const fn of cleanup) fn();
    cleanup = [];
  });

  it("copies the staged checkpoint into place when the live DB is missing", async () => {
    const f = makeFixture({ staged: Buffer.from("SQLite-pretend-bytes") });
    cleanup.push(() => rmSync(f.root, { recursive: true, force: true }));

    const result = await rehydrateFromBackup({ dataDir: f.dataDir });
    assert.equal(result, true);
    assert.equal(existsSync(f.liveDb), true);
    assert.equal(readFileSync(f.liveDb).toString(), "SQLite-pretend-bytes");
  });

  it("is a no-op when the live DB already exists (preserves running state)", async () => {
    const f = makeFixture({
      staged: Buffer.from("old-restored-data"),
      live: Buffer.from("current-live-data"),
    });
    cleanup.push(() => rmSync(f.root, { recursive: true, force: true }));

    const result = await rehydrateFromBackup({ dataDir: f.dataDir });
    assert.equal(result, false);
    assert.equal(readFileSync(f.liveDb).toString(), "current-live-data");
  });

  it("is a no-op when no staged backup is present (normal first-run case)", async () => {
    const f = makeFixture({});
    cleanup.push(() => rmSync(f.root, { recursive: true, force: true }));

    const result = await rehydrateFromBackup({ dataDir: f.dataDir });
    assert.equal(result, false);
    assert.equal(existsSync(f.liveDb), false);
  });

  it("creates the grafana-data directory if it doesn't exist yet", async () => {
    const f = makeFixture({ staged: Buffer.from("bytes") });
    cleanup.push(() => rmSync(f.root, { recursive: true, force: true }));
    // grafana-data dir is deliberately absent in this fixture (makeFixture
    // only creates it when opts.live is set), so rehydrate has to mkdir it.

    const result = await rehydrateFromBackup({ dataDir: f.dataDir });
    assert.equal(result, true);
    assert.equal(existsSync(f.liveDb), true);
  });

  it("logs the byte count when it copies", async () => {
    const f = makeFixture({ staged: Buffer.from("0123456789") });
    cleanup.push(() => rmSync(f.root, { recursive: true, force: true }));

    const messages: string[] = [];
    await rehydrateFromBackup({
      dataDir: f.dataDir,
      log: (msg) => messages.push(msg),
    });
    assert.ok(
      messages.some((m) => m.includes("rehydrated") && m.includes("10 bytes")),
    );
  });
});
