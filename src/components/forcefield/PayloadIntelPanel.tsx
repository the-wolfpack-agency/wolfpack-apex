"use client";

/**
 * Payload attacks - active exploitation, not just probing - in the shared
 * Forcefield language. Each attack kind is a red, pulsing node: this is the
 * most hostile signal on the page, so it reads that way at a glance. Only the
 * attack kind is kept, never the raw payload.
 */
import { IntelPanel, GlowNode, SEVERITY_COLOR } from "@/components/forcefield/intel-visuals";

export interface PayloadIntelEntry {
  attack: string;
  count: number;
}

export function PayloadIntelPanel({ intel }: { intel: readonly PayloadIntelEntry[] }) {
  if (!intel || intel.length === 0) return null;
  const red = SEVERITY_COLOR.hostile;
  return (
    <IntelPanel
      testId="ff-payload-intel"
      accent={red}
      title={<span style={{ color: red }}>Payload attacks · active exploitation attempts</span>}
      subtitle="Injection payloads agents actually sent in a request (not just a probe for a path), caught at the edge with our own red-team evasion knowledge. Only the attack kind is kept, never the raw payload."
    >
      <ul data-testid="payload-intel-list" style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
        {intel.map((pa) => (
          <li
            key={pa.attack}
            data-testid={`payload-intel-${pa.attack}`}
            style={{ display: "flex", alignItems: "center", gap: "0.5rem", border: `1px solid ${red}`, borderRadius: 999, padding: "0.28rem 0.7rem", background: `${red}14` }}
          >
            <GlowNode color={red} size={11} pulse />
            <span style={{ fontSize: "0.8rem", fontWeight: 600, color: "var(--wp-text, #eee)" }}>{pa.attack.replace(/_/g, " ")}</span>
            <span style={{ fontSize: "0.75rem", color: red, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{pa.count}&times;</span>
          </li>
        ))}
      </ul>
    </IntelPanel>
  );
}

export default PayloadIntelPanel;
