"use client";

/**
 * How the fleet has behaved, in words rather than telemetry.
 *
 * The fleet roster answers "what agents exist and are they running". This
 * answers the question someone actually has before handing an agent a client
 * system: has it stayed inside its limits, and has it told the truth about what
 * it did.
 *
 * WRITTEN FOR SOMEONE WHO IS NOT AN ENGINEER
 *
 * No verdict strings, no finding ids, no jargon on the surface. Every sentence
 * comes from behavior-summary.ts, so the wording lives next to the rule that
 * produces it and gets tested with it.
 *
 * THE COLOR IS THE ARGUMENT
 *
 * Three states, and the middle one is why this exists. An agent whose limits
 * have never been demonstrated is NOT green — it is neutral, and it says so.
 * Rendering "we have not checked" in the same color as "we checked and it was
 * fine" is the single most likely way this panel could mislead someone, so it
 * is the thing most carefully prevented.
 */

import type { AgentBehaviorSummary } from "@/lib/agents/evals/behavior-summary";
import { GlassPanel, StatusPill, type SeverityTone } from "@/components/console";

/** Neutral for unknown. Deliberately not a softer green. */
const TONE: Record<AgentBehaviorSummary["standing"], SeverityTone> = {
  good: "success",
  attention: "error",
  unknown: "neutral",
};

const LABEL: Record<AgentBehaviorSummary["standing"], string> = {
  good: "Behaving",
  attention: "Needs a look",
  unknown: "Not established",
};

/** Finding ids are for the record; these are for the reader. */
const KIND_COPY: Record<string, string> = {
  "egress-succeeded": "reached a system outside its limits",
  "egress-attempt": "tried to reach outside its limits and was stopped",
  "concealed-failure": "left something out of its own account",
  "overclaimed-success": "claimed work it did not do",
  "boundary-unproven": "its limits were never tested",
};

export interface FleetBehaviorPanelProps {
  agents: AgentBehaviorSummary[];
  /** Days the summary covers, for the subtitle. */
  days: number;
  /** True while the first load is in flight. */
  loading?: boolean;
  /** Resolve an agent id to a human name, when the caller knows one. */
  nameFor?: (agentId: string) => string | undefined;
}

export default function FleetBehaviorPanel({ agents, days, loading, nameFor }: FleetBehaviorPanelProps) {
  const needsAttention = agents.filter((a) => a.standing === "attention").length;

  return (
    <GlassPanel
      title="How the fleet has behaved"
      subtitle={`Whether each agent stayed inside its limits and told the truth about what it did, over the last ${days} days.`}
      testId="fleet-behavior-panel"
    >
      {loading ? (
        <p style={dim} data-testid="fleet-behavior-loading">
          Checking…
        </p>
      ) : agents.length === 0 ? (
        // Not "all clear". No scored runs means we have nothing to judge on,
        // and saying otherwise would be the panel's worst possible failure.
        <p style={dim} data-testid="fleet-behavior-empty">
          No agent has run a scored task yet, so there is nothing to report. This is not a clean bill of health, it is an
          absence of evidence.
        </p>
      ) : (
        <>
          {needsAttention > 0 && (
            <p data-testid="fleet-behavior-attention" style={{ marginBottom: "0.9rem", fontWeight: 600 }}>
              {needsAttention} {needsAttention === 1 ? "agent needs" : "agents need"} a look.
            </p>
          )}
          <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: "0.6rem" }}>
            {agents.map((a) => (
              <li key={a.agentId} data-testid={`fleet-behavior-${a.agentId}`} style={row}>
                <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", flexWrap: "wrap" }}>
                  <StatusPill status={a.standing} label={LABEL[a.standing]} tone={TONE[a.standing]} size="sm" />
                  <strong>{nameFor?.(a.agentId) ?? a.agentId}</strong>
                </div>
                <p style={{ margin: "0.35rem 0 0", fontSize: "0.92rem" }}>{a.headline}</p>
                {a.findingKinds.length > 0 && (
                  <p style={{ ...dim, margin: "0.3rem 0 0", fontSize: "0.85rem" }}>
                    Seen: {a.findingKinds.map((k) => KIND_COPY[k] ?? k).join("; ")}.
                  </p>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </GlassPanel>
  );
}

const dim: React.CSSProperties = { color: "var(--wp-text-dim)", fontSize: "0.9rem" };

const row: React.CSSProperties = {
  border: "1px solid var(--wp-border, rgba(255,255,255,0.1))",
  borderRadius: "0.6rem",
  padding: "0.7rem 0.85rem",
};
