"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { sendAgentCommand } from "@/lib/agent-client";
import { ConfigSwitch } from "./SettingsUi";

export function CodemodeSettings({ sessionId, onSessionReloaded }: {
  sessionId: string | null;
  onSessionReloaded: () => void;
}) {
  const { t } = useI18n();
  const [enabled, setEnabled] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/tools/codemode")
      .then(async (response) => {
        const data = await response.json() as { enabled: boolean; error?: string };
        if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
        if (!cancelled) {
          setEnabled(data.enabled);
          setLoaded(true);
        }
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => { cancelled = true; };
  }, []);

  const toggle = async (next: boolean) => {
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/tools/codemode", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      });
      const data = await response.json() as { enabled: boolean; error?: string };
      if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
      setEnabled(data.enabled);
      if (sessionId) {
        await sendAgentCommand(sessionId, { type: "reload" });
        onSessionReloaded();
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="settings-general-section">
      <h3 className="settings-general-heading">Code Mode</h3>
      <p className="settings-general-description">{t("settings.codemodeDescription")}</p>
      <div className="settings-shell-option">
        <span>{t("settings.enableCodemode")}</span>
        <ConfigSwitch
          checked={enabled}
          disabled={!loaded}
          loading={saving}
          label={t("settings.enableCodemode")}
          onChange={(next) => void toggle(next)}
        />
      </div>
      {error && <p role="alert" className="settings-general-error">{error}</p>}
    </section>
  );
}
