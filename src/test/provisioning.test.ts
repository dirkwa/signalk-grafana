import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { generateProvisioning } from "../provisioning";

const defaultConfig = {
  grafanaPort: 3001,
  grafanaVersion: "latest",
  adminPassword: "admin",
  anonymousAccess: true,
  questdbContainerName: "signalk-questdb",
  questdbPgPort: 8812,
  networkName: "sk-network",
  signalkUrl: "",
  bindToAllInterfaces: false,
};

describe("generateProvisioning", () => {
  let tempDir: string;

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  it("creates datasource YAML with QuestDB connection", () => {
    tempDir = mkdtempSync(join(tmpdir(), "grafana-test-"));
    generateProvisioning(tempDir, defaultConfig);

    const dsFile = join(tempDir, "provisioning/datasources/questdb.yaml");
    assert.ok(existsSync(dsFile), "datasource file should exist");

    const content = readFileSync(dsFile, "utf8");
    assert.ok(content.includes("sk-signalk-questdb:8812"));
    assert.ok(content.includes("type: postgres"));
    assert.ok(content.includes("uid: signalk-questdb"));
    assert.ok(content.includes("database: qdb"));
    assert.ok(content.includes("sslmode: disable"));
  });

  it("creates Signal K datasource YAML", () => {
    tempDir = mkdtempSync(join(tmpdir(), "grafana-test-"));
    generateProvisioning(tempDir, defaultConfig);

    const dsFile = join(tempDir, "provisioning/datasources/signalk.yaml");
    assert.ok(existsSync(dsFile), "signalk datasource file should exist");

    const content = readFileSync(dsFile, "utf8");
    assert.ok(content.includes("tkurki-signalk-datasource"));
    assert.ok(content.includes("host.containers.internal"));
    assert.ok(content.includes("context: self"));
  });

  it("uses custom QuestDB container name and port", () => {
    tempDir = mkdtempSync(join(tmpdir(), "grafana-test-"));
    generateProvisioning(tempDir, {
      ...defaultConfig,
      questdbContainerName: "my-questdb",
      questdbPgPort: 9999,
    });

    const content = readFileSync(
      join(tempDir, "provisioning/datasources/questdb.yaml"),
      "utf8",
    );
    assert.ok(content.includes("sk-my-questdb:9999"));
  });

  it("strips protocol from signalkUrl override", () => {
    tempDir = mkdtempSync(join(tmpdir(), "grafana-test-"));
    generateProvisioning(tempDir, {
      ...defaultConfig,
      signalkUrl: "http://192.168.0.122:3000",
    });

    const content = readFileSync(
      join(tempDir, "provisioning/datasources/signalk.yaml"),
      "utf8",
    );
    assert.ok(content.includes("192.168.0.122:3000"));
    assert.ok(!content.includes("http://http://"));
  });
});
