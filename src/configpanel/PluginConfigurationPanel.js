import React, { useState } from "react";
import {
  panelStyles as S,
  SectionTitle,
  StatusCard,
  FieldRow,
  VersionSelect,
  UpdateControls,
  ActionStatus,
  Button,
  useStatusPoll,
  useVersions,
} from "signalk-container-helper/ui";

const BASE = "/plugins/signalk-grafana";

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
  const [questdbHost, setQuestdbHost] = useState(cfg.questdbHost || "");
  const [questdbPgPort, setQuestdbPgPort] = useState(cfg.questdbPgPort || 8812);
  const [networkName, setNetworkName] = useState(
    cfg.networkName || "sk-network",
  );
  const [signalkUrl, setSignalkUrl] = useState(cfg.signalkUrl || "");
  const [subPath, setSubPath] = useState(cfg.subPath || "");
  const [bindToAllInterfaces, setBindToAllInterfaces] = useState(
    cfg.bindToAllInterfaces || false,
  );

  const [actionStatus, setActionStatus] = useState("");
  const [statusError, setStatusError] = useState(false);
  const [settingPassword, setSettingPassword] = useState(false);

  const { status, loading } = useStatusPoll(`${BASE}/api/status`, {
    fallback: { status: "not_running" },
  });
  const versions = useVersions(`${BASE}/api/versions`);

  const isRunning = status && status.status === "running";

  // WHY guard: Number("") is 0 — clearing a port field must not save 0.
  const numChange = (set) => (e) => {
    const n = Number(e.target.value);
    if (e.target.value !== "" && Number.isFinite(n)) set(n);
  };

  const setPassword = async () => {
    setSettingPassword(true);
    setActionStatus("Setting password...");
    setStatusError(false);
    try {
      const res = await fetch(`${BASE}/api/set-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: adminPassword }),
      });
      const data = await res.json().catch(() => ({ error: res.statusText }));
      if (res.ok) {
        setActionStatus(data.message);
      } else {
        setActionStatus(`Failed: ${data.error}`);
        setStatusError(true);
      }
    } catch (e) {
      setActionStatus(`Failed: ${e.message}`);
      setStatusError(true);
    }
    setSettingPassword(false);
  };

  const doSave = () => {
    // Spread cfg first so unrendered fields (tlsSkipVerify, requestSignalkToken) survive the save instead of being silently dropped.
    save({
      ...cfg,
      grafanaPort,
      grafanaVersion,
      adminPassword,
      anonymousAccess,
      questdbContainerName,
      questdbHost,
      questdbPgPort,
      signalkUrl,
      subPath,
      networkName,
      bindToAllInterfaces,
    });
    setActionStatus("Saved! Plugin will restart with new configuration.");
    setStatusError(false);
  };

  return (
    <div style={S.root}>
      <SectionTitle>Grafana Status</SectionTitle>

      <StatusCard
        icon="G"
        iconBackground={isRunning ? "#f46800" : undefined}
        title="Grafana"
        meta={
          loading
            ? "Checking Grafana..."
            : isRunning
              ? `v${status.version} · Port ${status.port}`
              : "Not running"
        }
        state={isRunning ? "ok" : "error"}
        link={
          isRunning
            ? {
                href: `http://${window.location.hostname}:${status.port}`,
                label: "Open Grafana ↗",
              }
            : undefined
        }
      />

      {isRunning && status.signalk && (
        <StatusCard
          icon="SK"
          iconBackground={status.signalk.reachable ? "#0ea5e9" : undefined}
          title="Signal K datasource"
          meta={
            status.signalk.reachable
              ? `Reachable from Grafana${
                  status.signalk.version ? ` · v${status.signalk.version}` : ""
                }${status.signalk.url ? ` · ${status.signalk.url}` : ""}`
              : `Unreachable from Grafana${
                  status.signalk.error ? ` (${status.signalk.error})` : ""
                }`
          }
          state={status.signalk.reachable ? "ok" : "error"}
        />
      )}

      {isRunning && (
        <UpdateControls
          checkUrl={`${BASE}/api/update/check`}
          applyUrl={`${BASE}/api/update/apply`}
          tag={grafanaVersion}
          onApplied={(tag) => setGrafanaVersion(tag)}
          updateLabel="Update Grafana"
        />
      )}

      <SectionTitle>Settings</SectionTitle>

      <FieldRow label="Grafana port" hint="avoid 3000 if Signal K uses it">
        <input
          style={S.inputSmall}
          type="number"
          value={grafanaPort}
          onChange={numChange(setGrafanaPort)}
        />
      </FieldRow>

      <FieldRow label="Image version">
        <VersionSelect
          value={grafanaVersion}
          onChange={setGrafanaVersion}
          versions={versions.versions}
          loading={versions.loading}
          error={versions.versionsError}
          onRefresh={versions.refresh}
        />
      </FieldRow>

      <FieldRow label="Admin password">
        <input
          style={S.input}
          type="text"
          value={adminPassword}
          onChange={(e) => setAdminPassword(e.target.value)}
        />
        <Button
          small
          onClick={setPassword}
          busy={settingPassword}
          busyLabel="Setting..."
        >
          Set & Save
        </Button>
      </FieldRow>

      <FieldRow label="Anonymous access" hint="view dashboards without login">
        <input
          type="checkbox"
          style={S.checkbox}
          checked={anonymousAccess}
          onChange={(e) => setAnonymousAccess(e.target.checked)}
        />
      </FieldRow>

      <SectionTitle>Data Sources</SectionTitle>

      <FieldRow
        label="Signal K URL override"
        hint="auto-detected, only set to override"
      >
        <input
          style={S.input}
          placeholder={`auto: host.containers.internal:${window.location.port || "3000"}`}
          value={signalkUrl}
          onChange={(e) => setSignalkUrl(e.target.value)}
        />
      </FieldRow>

      <FieldRow label="QuestDB container name">
        <input
          style={S.input}
          value={questdbContainerName}
          onChange={(e) => setQuestdbContainerName(e.target.value)}
        />
      </FieldRow>

      <FieldRow
        label="QuestDB host override"
        hint="for self-hosted QuestDB; empty uses the managed container"
      >
        <input
          style={S.input}
          placeholder="empty = managed container"
          value={questdbHost}
          onChange={(e) => setQuestdbHost(e.target.value)}
        />
      </FieldRow>

      <FieldRow label="PostgreSQL port">
        <input
          style={S.inputSmall}
          type="number"
          value={questdbPgPort}
          onChange={numChange(setQuestdbPgPort)}
        />
      </FieldRow>

      <FieldRow label="Network name" hint="shared network for container DNS">
        <input
          style={S.input}
          value={networkName}
          onChange={(e) => setNetworkName(e.target.value)}
        />
      </FieldRow>

      <FieldRow
        label="Bind to 0.0.0.0"
        hint={
          bindToAllInterfaces
            ? "Caution! This can expose Grafana to the internet"
            : "Only needed for remote access outside localhost"
        }
        hintColor={bindToAllInterfaces ? "#ef4444" : undefined}
      >
        <input
          type="checkbox"
          style={S.checkbox}
          checked={bindToAllInterfaces}
          onChange={(e) => setBindToAllInterfaces(e.target.checked)}
        />
      </FieldRow>

      <FieldRow
        label="Sub-path (reverse proxy)"
        hint="leave empty for direct access"
      >
        <input
          style={S.input}
          placeholder="e.g. /grafana/"
          value={subPath}
          onChange={(e) => setSubPath(e.target.value)}
        />
      </FieldRow>

      <ActionStatus message={actionStatus} error={statusError} />

      <div style={{ marginTop: 24 }}>
        <Button onClick={doSave}>Save Configuration</Button>
      </div>
    </div>
  );
}
