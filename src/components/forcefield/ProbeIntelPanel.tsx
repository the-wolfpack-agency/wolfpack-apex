"use client";

/**
 * Probe intelligence, in the shared Forcefield visual language: each sensitive
 * path an agent probed becomes a glowing severity node (critical pulses) with a
 * plain-language line naming what it was hunting for, its CWE, and how often.
 */
import { IntelPanel, GlowNode, SEVERITY_COLOR } from "@/components/forcefield/intel-visuals";

export interface ProbeIntelEntry {
  label: string;
  cwe: string;
  severity: "low" | "medium" | "high" | "critical";
  category: string;
  count: number;
}

const SEV_WORD: Record<ProbeIntelEntry["severity"], string> = {
  critical: "Critical exposure",
  high: "High risk",
  medium: "Worth noting",
  low: "Low risk",
};

export function ProbeIntelPanel({ intel }: { intel: readonly ProbeIntelEntry[] }) {
  if (!intel || intel.length === 0) return null;
  return (
    <IntelPanel
      testId="ff-probe-intel"
      accent="#e8b528"
      title="Probe intelligence · what agents are scanning us for"
      subtitle="Each sensitive path an agent probed, matched to the exposure it targets and its CWE. It is the same signature knowledge our own scanner uses, inverted to name what inbound traffic is hunting."
    >
      <ul data-testid="probe-intel-list" style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "0.45rem" }}>
        {intel.map((pi) => {
          const color = SEVERITY_COLOR[pi.severity];
          return (
            <li
              key={pi.label}
              data-testid={`probe-intel-${pi.cwe}`}
              style={{ display: "flex", alignItems: "center", gap: "0.7rem", flexWrap: "wrap", border: `1px solid ${color}33`, borderRadius: 8, padding: "0.55rem 0.75rem", background: "rgba(255,255,255,0.015)" }}
            >
              <GlowNode color={color} size={14} pulse={pi.severity === "critical"} />
              <div style={{ minWidth: 0, flex: "1 1 auto" }}>
                <div style={{ display: "flex", alignItems: "baseline", gap: "0.5rem", flexWrap: "wrap" }}>
                  <span style={{ fontSize: "0.84rem", fontWeight: 600, color: "var(--wp-text, #eee)" }}>{pi.label}</span>
                  <span style={{ fontFamily: "var(--wp-mono, ui-monospace, monospace)", fontSize: "0.68rem", color: "var(--wp-text-muted, #8b90a0)" }}>{pi.cwe}</span>
                </div>
                <span style={{ fontSize: "0.68rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em", color }}>{SEV_WORD[pi.severity]}</span>
              </div>
              <span style={{ flex: "0 0 auto", fontSize: "0.78rem", color: "var(--wp-text-muted, #9ca3af)", fontVariantNumeric: "tabular-nums" }}>{pi.count}&times;</span>
            </li>
          );
        })}
      </ul>
    </IntelPanel>
  );
}

export default ProbeIntelPanel;
