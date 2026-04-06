import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { generateProvisioning } from "../provisioning";

describe("generateProvisioning", () => {
  let tempDir: string;

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  it("creates datasource YAML with QuestDB connection", () => {
    tempDir = mkdtempSync(join(tmpdir(), "grafana-test-"));
    generateProvisioning(tempDir, {
      grafanaPort: 3001,
      grafanaVersion: "latest",
      adminPassword: "admin",
      anonymousAccess: true,
      questdbContainerName: "signalk-questdb",
      questdbPgPort: 8812,
      networkName: "sk-network",
      signalkUrl: "",
      bindToAllInterfaces: false,
    });

    const dsFile = join(tempDir, "provisioning/datasources/questdb.yaml");
    assert.ok(existsSync(dsFile), "datasource file should exist");

    const content = readFileSync(dsFile, "utf8");
    assert.ok(content.includes("sk-signalk-questdb:8812"));
    assert.ok(content.includes("type: postgres"));
    assert.ok(content.includes("user: admin"));
    assert.ok(content.includes("database: qdb"));
    assert.ok(content.includes("sslmode: disable"));
  });

  it("creates dashboard provider YAML", () => {
    tempDir = mkdtempSync(join(tmpdir(), "grafana-test-"));
    generateProvisioning(tempDir, {
      grafanaPort: 3001,
      grafanaVersion: "latest",
      adminPassword: "admin",
      anonymousAccess: true,
      questdbContainerName: "signalk-questdb",
      questdbPgPort: 8812,
      networkName: "sk-network",
      signalkUrl: "",
      bindToAllInterfaces: false,
    });

    const provFile = join(tempDir, "provisioning/dashboards/signalk.yaml");
    assert.ok(existsSync(provFile), "dashboard provider file should exist");

    const content = readFileSync(provFile, "utf8");
    assert.ok(content.includes("Signal K"));
    assert.ok(content.includes("/var/lib/grafana/dashboards"));
  });

  it("creates dashboard directory", () => {
    tempDir = mkdtempSync(join(tmpdir(), "grafana-test-"));
    generateProvisioning(tempDir, {
      grafanaPort: 3001,
      grafanaVersion: "latest",
      adminPassword: "admin",
      anonymousAccess: true,
      questdbContainerName: "signalk-questdb",
      questdbPgPort: 8812,
      networkName: "sk-network",
      signalkUrl: "",
      bindToAllInterfaces: false,
    });

    assert.ok(
      existsSync(join(tempDir, "dashboards")),
      "dashboards directory should exist",
    );
  });

  it("uses custom QuestDB container name and port", () => {
    tempDir = mkdtempSync(join(tmpdir(), "grafana-test-"));
    generateProvisioning(tempDir, {
      grafanaPort: 3001,
      grafanaVersion: "latest",
      adminPassword: "admin",
      anonymousAccess: true,
      questdbContainerName: "my-questdb",
      questdbPgPort: 9999,
      networkName: "custom-net",
      signalkUrl: "",
      bindToAllInterfaces: false,
    });

    const content = readFileSync(
      join(tempDir, "provisioning/datasources/questdb.yaml"),
      "utf8",
    );
    assert.ok(content.includes("sk-my-questdb:9999"));
  });
});
