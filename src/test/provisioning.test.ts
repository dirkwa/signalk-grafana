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
  questdbHost: "",
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

  it("provisions the native QuestDB datasource as the default", () => {
    tempDir = mkdtempSync(join(tmpdir(), "grafana-test-"));
    generateProvisioning(tempDir, defaultConfig);

    const content = readFileSync(
      join(tempDir, "provisioning/datasources/questdb.yaml"),
      "utf8",
    );
    assert.ok(content.includes("type: questdb-questdb-datasource"));
    assert.ok(content.includes("uid: signalk-questdb-native"));
    assert.ok(content.includes("server: sk-signalk-questdb"));
    assert.ok(content.includes("port: 8812"));
    assert.ok(content.includes("tlsMode: disable"));
    assert.ok(content.includes("username: admin"));
    assert.ok(content.includes("password: quest"));
    assert.ok(content.includes("maxOpenConnections: 8"));
    assert.ok(content.includes("maxIdleConnections: 2"));
    assert.ok(content.includes("maxConnectionLifetime: 14400"));
    // Exactly one default — the native entry; postgres stays for old dashboards.
    assert.equal((content.match(/isDefault: true/g) || []).length, 1);
    assert.ok(
      content.indexOf("isDefault: true") <
        content.indexOf("grafana-postgresql-datasource"),
    );
    assert.ok(content.includes("isDefault: false"));
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
    assert.ok(content.includes("server: sk-my-questdb"));
    assert.ok(content.includes("port: 9999"));
  });

  it("uses the QuestDB host override in both datasource entries", () => {
    tempDir = mkdtempSync(join(tmpdir(), "grafana-test-"));
    generateProvisioning(tempDir, {
      ...defaultConfig,
      questdbHost: " 192.168.1.50 ",
    });

    const content = readFileSync(
      join(tempDir, "provisioning/datasources/questdb.yaml"),
      "utf8",
    );
    // Quoted: digit-initial values are outside the provably-safe plain-scalar set.
    assert.ok(content.includes('server: "192.168.1.50"'));
    assert.ok(content.includes('url: "192.168.1.50:8812"'));
    assert.ok(!content.includes("sk-signalk-questdb"));
  });

  it("accepts a bracketed IPv6 host override", () => {
    tempDir = mkdtempSync(join(tmpdir(), "grafana-test-"));
    generateProvisioning(tempDir, {
      ...defaultConfig,
      questdbHost: "[fd00::10]",
    });

    const content = readFileSync(
      join(tempDir, "provisioning/datasources/questdb.yaml"),
      "utf8",
    );
    // Quoted: unquoted bracketed literals parse as YAML flow sequences.
    assert.ok(content.includes('server: "[fd00::10]"'));
    assert.ok(content.includes('url: "[fd00::10]:8812"'));
  });

  it("accepts an IPv4-mapped bracketed IPv6 host override", () => {
    tempDir = mkdtempSync(join(tmpdir(), "grafana-test-"));
    generateProvisioning(tempDir, {
      ...defaultConfig,
      questdbHost: "[::ffff:192.0.2.1]",
    });

    const content = readFileSync(
      join(tempDir, "provisioning/datasources/questdb.yaml"),
      "utf8",
    );
    assert.ok(content.includes('server: "[::ffff:192.0.2.1]"'));
  });

  it("accepts container names with mid-label underscores", () => {
    // Legacy Compose container names carry underscores and container DNS resolves them.
    tempDir = mkdtempSync(join(tmpdir(), "grafana-test-"));
    generateProvisioning(tempDir, {
      ...defaultConfig,
      questdbHost: "quest_db",
    });

    const content = readFileSync(
      join(tempDir, "provisioning/datasources/questdb.yaml"),
      "utf8",
    );
    assert.ok(content.includes("server: quest_db"));
  });

  it("quotes YAML-typable host overrides", () => {
    // Unquoted, YAML would type these as int, sexagesimal, timestamp, hex,
    // underscore-int, exponent float, or boolean.
    for (const coercible of [
      "123",
      "2024-01-01",
      "0x10",
      "1_000",
      "1e5",
      "no",
    ]) {
      tempDir = mkdtempSync(join(tmpdir(), "grafana-test-"));
      generateProvisioning(tempDir, {
        ...defaultConfig,
        questdbHost: coercible,
      });
      const content = readFileSync(
        join(tempDir, "provisioning/datasources/questdb.yaml"),
        "utf8",
      );
      assert.ok(
        content.includes(`server: "${coercible}"`),
        `${coercible} must be quoted`,
      );
      assert.ok(
        content.includes(`url: "${coercible}:8812"`),
        `${coercible} url must be quoted`,
      );
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("derives the managed container DNS name when the override is empty", () => {
    tempDir = mkdtempSync(join(tmpdir(), "grafana-test-"));
    generateProvisioning(tempDir, { ...defaultConfig, questdbHost: "   " });

    const content = readFileSync(
      join(tempDir, "provisioning/datasources/questdb.yaml"),
      "utf8",
    );
    assert.ok(content.includes("server: sk-signalk-questdb"));
  });

  it("rejects QuestDB host overrides that are not a bare host", () => {
    tempDir = mkdtempSync(join(tmpdir(), "grafana-test-"));
    for (const bad of [
      "http://192.168.1.50",
      "192.168.1.50:8812",
      "host name",
      'quest"\ninjected: yes',
      "[::::]",
      "db..lan",
      "db-.lan",
      "-db.lan",
    ]) {
      assert.throws(
        () =>
          generateProvisioning(tempDir, { ...defaultConfig, questdbHost: bad }),
        /Invalid QuestDB host override/,
        `should reject ${JSON.stringify(bad)}`,
      );
    }
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
    // 4-space indent nests under the list item; 2-space gets rejected by Grafana with "did not find expected '-' indicator".
    assert.ok(
      content.includes(`    secureJsonData:\n      token: ${jwt}\n`),
      "secureJsonData/token must be indented under the - name: list item",
    );
    assert.ok(
      !content.includes(`  secureJsonData:\n    token:`),
      "secureJsonData must not be at sequence-sibling indent",
    );
  });

  it("emits tlsSkipVerify when the probed endpoint is self-signed https", () => {
    tempDir = mkdtempSync(join(tmpdir(), "grafana-test-"));
    generateProvisioning(tempDir, defaultConfig, undefined, {
      host: "host.containers.internal:443",
      ssl: true,
      tlsSkipVerify: true,
    });

    const content = readFileSync(
      join(tempDir, "provisioning/datasources/signalk.yaml"),
      "utf8",
    );
    assert.ok(content.includes("url: https://host.containers.internal:443"));
    assert.ok(content.includes("ssl: true"));
    assert.ok(
      content.includes("      tlsSkipVerify: true\n"),
      "tlsSkipVerify must be 6-space indented under jsonData",
    );
  });

  it("omits tlsSkipVerify when the probed endpoint does not need it", () => {
    tempDir = mkdtempSync(join(tmpdir(), "grafana-test-"));
    generateProvisioning(tempDir, defaultConfig, undefined, {
      host: "host.containers.internal:443",
      ssl: true,
      tlsSkipVerify: false,
    });

    const content = readFileSync(
      join(tempDir, "provisioning/datasources/signalk.yaml"),
      "utf8",
    );
    assert.ok(content.includes("ssl: true"));
    assert.ok(!content.includes("tlsSkipVerify"));
  });

  it("lets a signalkUrl override win over a probed endpoint", () => {
    tempDir = mkdtempSync(join(tmpdir(), "grafana-test-"));
    generateProvisioning(
      tempDir,
      { ...defaultConfig, signalkUrl: "http://192.168.0.122:3000" },
      undefined,
      { host: "host.containers.internal:443", ssl: true, tlsSkipVerify: true },
    );

    const content = readFileSync(
      join(tempDir, "provisioning/datasources/signalk.yaml"),
      "utf8",
    );
    assert.ok(content.includes("url: http://192.168.0.122:3000"));
    assert.ok(content.includes("ssl: false"));
    assert.ok(!content.includes("tlsSkipVerify"));
  });

  it("emits tlsSkipVerify for an https override when config opts in", () => {
    tempDir = mkdtempSync(join(tmpdir(), "grafana-test-"));
    generateProvisioning(tempDir, {
      ...defaultConfig,
      signalkUrl: "https://192.168.0.122:443",
      tlsSkipVerify: true,
    });

    // URL.host strips default :443 for https; datasource defaults to 443 anyway.
    const content = readFileSync(
      join(tempDir, "provisioning/datasources/signalk.yaml"),
      "utf8",
    );
    assert.ok(content.includes("url: https://192.168.0.122"));
    assert.ok(content.includes("ssl: true"));
    assert.ok(content.includes("      tlsSkipVerify: true\n"));
  });

  it("does not emit tlsSkipVerify for an https override without opt-in", () => {
    tempDir = mkdtempSync(join(tmpdir(), "grafana-test-"));
    generateProvisioning(tempDir, {
      ...defaultConfig,
      signalkUrl: "https://192.168.0.122:8443",
    });

    const content = readFileSync(
      join(tempDir, "provisioning/datasources/signalk.yaml"),
      "utf8",
    );
    assert.ok(content.includes("ssl: true"));
    assert.ok(!content.includes("tlsSkipVerify"));
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
