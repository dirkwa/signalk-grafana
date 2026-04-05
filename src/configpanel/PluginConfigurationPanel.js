import React, { useState, useEffect, useCallback } from "react";

const S = {
  root: {
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    color: "#333",
    padding: "16px 0",
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: 600,
    color: "#888",
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    marginBottom: 10,
    marginTop: 24,
  },
  btn: {
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    padding: "8px 16px",
    border: "none",
    borderRadius: 6,
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
  },
  btnPrimary: { background: "#3b82f6", color: "#fff" },
  btnSave: { background: "#3b82f6", color: "#fff" },
  status: { marginTop: 8, fontSize: 12, minHeight: 18 },
  card: {
    display: "flex",
    alignItems: "center",
    gap: 14,
    padding: "14px 18px",
    background: "#f8f9fa",
    border: "1px solid #e0e0e0",
    borderRadius: 10,
    marginBottom: 12,
  },
  cardIcon: {
    width: 44,
    height: 44,
    borderRadius: 10,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 20,
    fontWeight: 700,
    flexShrink: 0,
  },
  cardInfo: { flex: 1 },
  cardTitle: { fontSize: 15, fontWeight: 600, color: "#333" },
  cardMeta: { fontSize: 12, color: "#888" },
  stateIndicator: {
    width: 10,
    height: 10,
    borderRadius: "50%",
    flexShrink: 0,
  },
  fieldRow: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    marginBottom: 10,
  },
  label: {
    fontSize: 13,
    fontWeight: 500,
    color: "#555",
    width: 180,
    flexShrink: 0,
  },
  input: {
    padding: "6px 10px",
    borderRadius: 6,
    border: "1px solid #ccc",
    fontSize: 13,
    background: "#fff",
    color: "#333",
    width: 200,
  },
  inputSmall: {
    padding: "6px 10px",
    borderRadius: 6,
    border: "1px solid #ccc",
    fontSize: 13,
    background: "#fff",
    color: "#333",
    width: 80,
  },
  checkbox: { width: 16, height: 16, accentColor: "#3b82f6" },
  hint: { fontSize: 11, color: "#aaa", marginLeft: 8 },
  link: {
    color: "#3b82f6",
    textDecoration: "none",
    fontSize: 13,
    fontWeight: 600,
  },
};

export default function PluginConfigurationPanel({ configuration, save }) {
  const cfg = configuration || {};

  const [grafanaPort, setGrafanaPort] = useState(cfg.grafanaPort || 3001);
  const [grafanaVersion, setGrafanaVersion] = useState(
    cfg.grafanaVersion || "latest",
  );
  const [adminPassword, setAdminPassword] = useState(
    cfg.adminPassword || "admin",
  );
  const [anonymousAccess, setAnonymousAccess] = useState(
    cfg.anonymousAccess !== false,
  );
  const [questdbContainerName, setQuestdbContainerName] = useState(
    cfg.questdbContainerName || "signalk-questdb",
  );
  const [questdbPgPort, setQuestdbPgPort] = useState(cfg.questdbPgPort || 8812);
  const [networkName, setNetworkName] = useState(
    cfg.networkName || "sk-network",
  );

  const [grafanaStatus, setGrafanaStatus] = useState(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [actionStatus, setActionStatus] = useState("");
  const [statusError, setStatusError] = useState(false);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/plugins/signalk-grafana/api/status");
      if (res.ok) {
        setGrafanaStatus(await res.json());
      } else {
        setGrafanaStatus({ status: "not_running" });
      }
    } catch {
      setGrafanaStatus({ status: "not_running" });
    }
    setStatusLoading(false);
  }, []);

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 5000);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  const doSave = () => {
    save({
      grafanaPort,
      grafanaVersion,
      adminPassword,
      anonymousAccess,
      questdbContainerName,
      questdbPgPort,
      networkName,
    });
    setActionStatus("Saved! Plugin will restart with new configuration.");
    setStatusError(false);
  };

  const isRunning = grafanaStatus && grafanaStatus.status === "running";

  return (
    <div style={S.root}>
      <div style={S.sectionTitle}>Grafana Status</div>

      {statusLoading ? (
        <div style={{ padding: "16px", color: "#999", fontSize: 13 }}>
          Checking Grafana...
        </div>
      ) : isRunning ? (
        <div style={S.card}>
          <div style={{ ...S.cardIcon, background: "#f46800", color: "#fff" }}>
            G
          </div>
          <div style={S.cardInfo}>
            <div style={S.cardTitle}>Grafana</div>
            <div style={S.cardMeta}>
              v{grafanaStatus.version} &middot; Port {grafanaStatus.port}
            </div>
          </div>
          <a
            href={`http://${window.location.hostname}:${grafanaStatus.port}`}
            target="_blank"
            rel="noopener noreferrer"
            style={S.link}
          >
            Open Grafana ↗
          </a>
          <div
            style={{ ...S.stateIndicator, background: "#10b981" }}
            title="Running"
          />
        </div>
      ) : (
        <div style={S.card}>
          <div
            style={{ ...S.cardIcon, background: "#fef2f2", color: "#ef4444" }}
          >
            G
          </div>
          <div style={S.cardInfo}>
            <div style={S.cardTitle}>Grafana</div>
            <div style={S.cardMeta}>Not running</div>
          </div>
          <div style={{ ...S.stateIndicator, background: "#ef4444" }} />
        </div>
      )}

      <div style={S.sectionTitle}>Settings</div>

      <div style={S.fieldRow}>
        <span style={S.label}>Grafana port</span>
        <input
          style={S.inputSmall}
          type="number"
          value={grafanaPort}
          onChange={(e) => setGrafanaPort(Number(e.target.value))}
        />
        <span style={S.hint}>avoid 3000 if Signal K uses it</span>
      </div>

      <div style={S.fieldRow}>
        <span style={S.label}>Image version</span>
        <input
          style={S.input}
          value={grafanaVersion}
          onChange={(e) => setGrafanaVersion(e.target.value)}
        />
      </div>

      <div style={S.fieldRow}>
        <span style={S.label}>Admin password</span>
        <input
          style={S.input}
          type="password"
          value={adminPassword}
          onChange={(e) => setAdminPassword(e.target.value)}
        />
        <span style={S.hint}>set on first run only</span>
      </div>

      <div style={S.fieldRow}>
        <span style={S.label}>Anonymous access</span>
        <input
          type="checkbox"
          style={S.checkbox}
          checked={anonymousAccess}
          onChange={(e) => setAnonymousAccess(e.target.checked)}
        />
        <span style={S.hint}>view dashboards without login</span>
      </div>

      <div style={S.sectionTitle}>QuestDB Connection</div>

      <div style={S.fieldRow}>
        <span style={S.label}>QuestDB container name</span>
        <input
          style={S.input}
          value={questdbContainerName}
          onChange={(e) => setQuestdbContainerName(e.target.value)}
        />
      </div>

      <div style={S.fieldRow}>
        <span style={S.label}>PostgreSQL port</span>
        <input
          style={S.inputSmall}
          type="number"
          value={questdbPgPort}
          onChange={(e) => setQuestdbPgPort(Number(e.target.value))}
        />
      </div>

      <div style={S.fieldRow}>
        <span style={S.label}>Network name</span>
        <input
          style={S.input}
          value={networkName}
          onChange={(e) => setNetworkName(e.target.value)}
        />
        <span style={S.hint}>shared network for container DNS</span>
      </div>

      {actionStatus && (
        <div
          style={{
            ...S.status,
            color: statusError ? "#ef4444" : "#10b981",
            marginTop: 16,
          }}
        >
          {actionStatus}
        </div>
      )}

      <div style={{ marginTop: 24 }}>
        <button style={{ ...S.btn, ...S.btnSave }} onClick={doSave}>
          Save Configuration
        </button>
      </div>
    </div>
  );
}
