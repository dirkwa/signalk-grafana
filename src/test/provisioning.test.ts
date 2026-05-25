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
  subPath: "",
  bindToAllInterfaces: false,
  requestSignalkToken: true,
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
    assert.ok(content.includes("type: grafana-postgresql-datasource"));
    assert.ok(content.includes("uid: signalk-questdb"));
    assert.ok(content.includes("database: qdb"));
    assert.ok(content.includes("sslmode: disable"));
  });

  it("creates Signal K datasource YAML using auto-detected host", () => {
    tempDir = mkdtempSync(join(tmpdir(), "grafana-test-"));
    const prevPort = process.env.PORT;
    process.env.PORT = "4100";
    try {
      generateProvisioning(tempDir, defaultConfig);
    } finally {
      if (prevPort === undefined) delete process.env.PORT;
      else process.env.PORT = prevPort;
    }

    const dsFile = join(tempDir, "provisioning/datasources/signalk.yaml");
    assert.ok(existsSync(dsFile), "signalk datasource file should exist");

    const content = readFileSync(dsFile, "utf8");
    assert.ok(content.includes("type: tkurki-signalk-datasource"));
    assert.ok(content.includes("uid: signalk"));
    assert.ok(content.includes("url: http://host.containers.internal:4100"));
    assert.ok(content.includes("hostname: host.containers.internal:4100"));
    assert.ok(content.includes("context: self"));
  });

  it("preserves https scheme in signalkUrl override", () => {
    tempDir = mkdtempSync(join(tmpdir(), "grafana-test-"));
    generateProvisioning(tempDir, {
      ...defaultConfig,
      signalkUrl: "https://192.168.0.122:3000",
    });

    const content = readFileSync(
      join(tempDir, "provisioning/datasources/signalk.yaml"),
      "utf8",
    );
    assert.ok(content.includes("url: https://192.168.0.122:3000"));
    assert.ok(content.includes("hostname: 192.168.0.122:3000"));
    assert.ok(content.includes("ssl: true"));
  });

  it("preserves http scheme in signalkUrl override", () => {
    tempDir = mkdtempSync(join(tmpdir(), "grafana-test-"));
    generateProvisioning(tempDir, {
      ...defaultConfig,
      signalkUrl: "http://192.168.0.122:3000",
    });

    const content = readFileSync(
      join(tempDir, "provisioning/datasources/signalk.yaml"),
      "utf8",
    );
    assert.ok(content.includes("url: http://192.168.0.122:3000"));
    assert.ok(content.includes("ssl: false"));
  });

  it("defaults to http when signalkUrl override has no scheme", () => {
    tempDir = mkdtempSync(join(tmpdir(), "grafana-test-"));
    generateProvisioning(tempDir, {
      ...defaultConfig,
      signalkUrl: "192.168.0.122:3000",
    });

    const content = readFileSync(
      join(tempDir, "provisioning/datasources/signalk.yaml"),
      "utf8",
    );
    assert.ok(content.includes("url: http://192.168.0.122:3000"));
    assert.ok(content.includes("hostname: 192.168.0.122:3000"));
    assert.ok(content.includes("ssl: false"));
  });

  it("rejects signalkUrl with non-http(s) scheme instead of silently downgrading", () => {
    tempDir = mkdtempSync(join(tmpdir(), "grafana-test-"));
    assert.throws(
      () =>
        generateProvisioning(tempDir, {
          ...defaultConfig,
          signalkUrl: "htps://192.168.0.122:3000",
        }),
      /Invalid signalkUrl protocol "htps:"/,
    );
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

  it("omits useAuth=true and secureJsonData when no token is supplied", () => {
    // Unsecured SK / user opted out — datasource hits the noauth route in
    // tkurki-signalk-datasource and SK serves anonymously.
    tempDir = mkdtempSync(join(tmpdir(), "grafana-test-"));
    generateProvisioning(tempDir, defaultConfig);

    const content = readFileSync(
      join(tempDir, "provisioning/datasources/signalk.yaml"),
      "utf8",
    );
    assert.ok(content.includes("useAuth: false"));
    assert.ok(
      !content.includes("secureJsonData"),
      "should not write secureJsonData when no token",
    );
    assert.ok(
      !content.includes("token:"),
      "should not write any token line when no token",
    );
  });

  it("injects useAuth=true and secureJsonData.token when a token is supplied", () => {
    // Secured SK path — the tkurki datasource sees useAuth=true and
    // routes to the authed HTTP route, picking the bearer token out
    // of secureJsonData server-side and forwarding it to SK.
    tempDir = mkdtempSync(join(tmpdir(), "grafana-test-"));
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzaWduYWxrLWdyYWZhbmEifQ.abcDEF_123-456";
    generateProvisioning(tempDir, defaultConfig, jwt);

    const content = readFileSync(
      join(tempDir, "provisioning/datasources/signalk.yaml"),
      "utf8",
    );
    assert.ok(content.includes("useAuth: true"));
    assert.ok(content.includes("secureJsonData:"));
    assert.ok(content.includes(`token: ${jwt}`));
  });

  it("rejects tokens that don't match the JWT shape", () => {
    // The YAML is built as a string template; refusing malformed input
    // at this layer protects against future yaml-injection if a caller
    // ever passes user input through unchecked.
    tempDir = mkdtempSync(join(tmpdir(), "grafana-test-"));
    assert.throws(
      () =>
        generateProvisioning(
          tempDir,
          defaultConfig,
          "not a jwt\ninjected: yes",
        ),
      /does not match the expected JWT shape/,
    );
  });
});
