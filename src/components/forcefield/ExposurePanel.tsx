"use client";

/**
 * Forcefield console - Exposure panel.
 *
 * Shows edge-device exposure findings (internet-facing firewall / SSL-VPN
 * portals mapped to CISA Known Exploited Vulnerabilities) recorded by platform
 * scans of the workspace's verified targets. Read-only, via fetchWithRefresh.
 *
 * Honest by construction: an explicit empty state, an explicit "switched off"
 * state, an explicit error state, and the scope line on every render: this is
 * outside-in monitoring and Forcefield does not protect the appliance.
 */
import { useCallback, useEffect, useState } from "react";
import { fetchWithRefresh } from "@/lib/client-auth";
import { GlassPanel, StatusPill } from "@/components/console";

export interface ExposureFinding {
  id: string;
  platform: string;
  route: string;
  severity: "critical" | "high" | "medium" | "low";
  title: string;
  status: string;
  vendor: string;
  product: string;
  cveIds: string[];
  knownRansomware: boolean;
  createdAt: string;
}

export interface ExposureResponse {
  enabled: boolean;
  kev: { catalogVersion: string; dateReleased: string };
  scope: string;
  findings: ExposureFinding[];
}

const SEVERITY_TONE: Record<ExposureFinding["severity"], "error" | "warning" | "neutral"> = {
  critical: "error",
  high: "error",
  medium: "warning",
  low: "neutral",
};

const MUTED = "var(--wp-text-dim, #b4bcc8)";

export function ExposurePanel() {
  const [data, setData] = useState<ExposureResponse | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "error">("loading");

  const load = useCallback(async () => {
    try {
      const res = await fetchWithRefresh("/api/admin/forcefield/exposure");
      if (!res.ok) {
        setState("error");
        return;
      }
      const body = (await res.json()) as Partial<ExposureResponse>;
      setData({
        enabled: body.enabled === true,
        kev: body.kev ?? { catalogVersion: "", dateReleased: "" },
        scope: body.scope ?? "",
        findings: Array.isArray(body.findings) ? body.findings : [],
      });
      setState("ok");
    } catch {
      setState("error");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const findings = data?.findings ?? [];

  return (
    <GlassPanel style={{ marginBottom: "1.25rem" }}>
      <div data-testid="exposure-panel" style={{ display: "grid", gap: "0.6rem" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: "0.6rem", flexWrap: "wrap" }}>
          <h3 style={{ margin: 0, fontSize: "1rem", color: "var(--wp-text, #e6e9ef)" }}>Exposure</h3>
          {data?.kev.catalogVersion && (
            <span data-testid="exposure-kev-version" style={{ fontSize: "0.75rem", color: MUTED }}>
              CISA KEV catalog {data.kev.catalogVersion}
            </span>
          )}
        </div>
        <p data-testid="exposure-scope" style={{ margin: 0, fontSize: "0.82rem", lineHeight: 1.55, color: MUTED, maxWidth: "78ch" }}>
          {data?.scope ||
            "Outside-in exposure monitoring of verified targets. Forcefield does not sit in front of these appliances and does not protect them."}
        </p>

        {state === "loading" && (
          <p data-testid="exposure-loading" style={{ margin: 0, color: MUTED }}>Loading...</p>
        )}
        {state === "error" && (
          <p data-testid="exposure-error" style={{ margin: 0, color: "var(--wp-error, #e5484d)", fontSize: "0.9rem" }}>
            Could not load exposure findings.
          </p>
        )}
        {state === "ok" && data && !data.enabled && findings.length === 0 && (
          <p data-testid="exposure-disabled" style={{ margin: 0, color: MUTED, fontSize: "0.88rem" }}>
            Edge-device exposure checks are switched off. When enabled, platform scans of verified targets report
            internet-facing firewall and VPN portals with known-exploited CVEs here.
          </p>
        )}
        {state === "ok" && data && data.enabled && findings.length === 0 && (
          <p data-testid="exposure-empty" style={{ margin: 0, color: MUTED, fontSize: "0.88rem" }}>
            No exposed edge devices found on verified targets. Nothing here is the good state.
          </p>
        )}
        {state === "ok" && findings.length > 0 && (
          <div data-testid="exposure-list" style={{ display: "grid", gap: "0.5rem" }}>
            {findings.map((f) => (
              <div
                key={f.id}
                data-testid="exposure-row"
                style={{ display: "grid", gap: "0.3rem", padding: "0.55rem 0.7rem", borderRadius: 8, background: "var(--wp-surface, #171a21)", minWidth: 0 }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", flexWrap: "wrap", minWidth: 0 }}>
                  <StatusPill status={f.severity} tone={SEVERITY_TONE[f.severity]} label={f.severity} />
                  <span style={{ fontWeight: 600, color: "var(--wp-text, #e6e9ef)", overflowWrap: "anywhere" }}>{f.title}</span>
                </div>
                <span style={{ fontSize: "0.8rem", color: MUTED, overflowWrap: "anywhere" }}>
                  {f.platform} {f.vendor ? `- ${f.vendor}` : ""}
                  {f.knownRansomware ? " - linked to ransomware campaigns" : ""}
                </span>
                {f.cveIds.length > 0 && (
                  <span data-testid="exposure-cves" style={{ fontSize: "0.76rem", fontFamily: "var(--wp-mono, ui-monospace, monospace)", color: MUTED, overflowWrap: "anywhere" }}>
                    {f.cveIds.join(", ")}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </GlassPanel>
  );
}
