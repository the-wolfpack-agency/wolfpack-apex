"use client";

/**
 * An agent, explained to the person who has to approve it.
 *
 * The barrier to AI inside a company is rarely capability — it is that the
 * people who must sign off cannot tell what a thing is allowed to do or whether
 * it has behaved, so the safe answer is no. This card answers those two
 * questions in the order someone actually asks them:
 *
 *   who is this        name, role, and a stable face so it is recognisable
 *   what can it touch   the systems it can reach, concretely enough to refuse
 *   what has it done    its record, and whether that record means anything
 *   what is behind it   which model, and whose
 *
 * THE CONSTRAINT THAT SHAPES EVERYTHING HERE
 *
 * A face makes a thing feel trustworthy. That is why this works and why it is
 * dangerous. The rule is that the card may make an agent easier to UNDERSTAND
 * and must never make it look safer than the evidence supports — so the avatar
 * is identical for a well-behaved and a misbehaving agent, the colour that
 * carries meaning is the standing pill and nothing else, and an agent whose
 * limits were never demonstrated says so in the same words however tidy the
 * rest of the card looks.
 *
 * Every sentence comes from lib/agents/persona, so the wording sits next to the
 * rule that produces it and is covered by its tests.
 */

import {
  describeCapabilities,
  describeModel,
  describeState,
  hueFor,
  initialsFor,
  trustLine,
  type AgentLifecycle,
} from "@/lib/agents/persona";
import { StatusPill, GlassPanel, type SeverityTone } from "@/components/console";

export interface AgentIdentityCardProps {
  agent: {
    id: string;
    name: string;
    role: string;
    state: AgentLifecycle;
    description?: string | null;
    connections?: string[];
  };
  /** From the behaviour summary. Absent means never scored, which is NOT clean. */
  behaviour?: { standing: "good" | "attention" | "unknown"; runs: number };
  boundaryProven?: boolean;
  model?: { id: string; clientSupplied: boolean };
  testId?: string;
}

/** Neutral for unknown. Deliberately not a softer green: not knowing is not a pass. */
const TONE: Record<"good" | "attention" | "unknown", SeverityTone> = {
  good: "success",
  attention: "error",
  unknown: "neutral",
};

const TRUST_LABEL: Record<"good" | "attention" | "unknown", string> = {
  good: "Behaving",
  attention: "Needs a look",
  unknown: "Not established",
};

export default function AgentIdentityCard({
  agent,
  behaviour,
  boundaryProven,
  model,
  testId,
}: AgentIdentityCardProps) {
  const state = describeState(agent.state);
  const trust = trustLine({
    state: agent.state,
    standing: behaviour?.standing,
    runs: behaviour?.runs,
    boundaryProven,
  });
  const hue = hueFor(agent.id);

  return (
    <GlassPanel testId={testId ?? `agent-card-${agent.id}`}>
      <div style={{ display: "flex", gap: "0.9rem", alignItems: "flex-start" }}>
        {/*
          Identity, not endorsement. The same shape and weight whatever the
          agent has done — a misbehaving agent must not look friendlier because
          its initials happen to be pleasant.
        */}
        <div
          aria-hidden="true"
          data-testid="agent-avatar"
          data-hue={hue}
          style={{
            width: 48,
            height: 48,
            flexShrink: 0,
            borderRadius: "0.7rem",
            background: `hsl(${hue} 45% 22%)`,
            border: `1px solid hsl(${hue} 45% 38%)`,
            color: `hsl(${hue} 70% 82%)`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontWeight: 700,
            letterSpacing: "0.03em",
          }}
        >
          {initialsFor(agent.name)}
        </div>

        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: "flex", gap: "0.55rem", alignItems: "center", flexWrap: "wrap" }}>
            <strong style={{ fontSize: "1.05rem" }}>{agent.name}</strong>
            <StatusPill status={agent.state} label={state.label} size="sm" />
            {/* The one place colour carries a judgement. */}
            <StatusPill
              status={trust.tone}
              label={TRUST_LABEL[trust.tone]}
              tone={TONE[trust.tone]}
              size="sm"
            />
          </div>

          <p style={{ ...dim, margin: "0.2rem 0 0" }}>{agent.role}</p>
          {agent.description && <p style={{ margin: "0.5rem 0 0" }}>{agent.description}</p>}

          <p style={{ margin: "0.7rem 0 0" }} data-testid="agent-trust">
            {trust.headline}
          </p>

          <p style={{ ...dim, margin: "0.5rem 0 0" }} data-testid="agent-state">
            {state.detail}
          </p>

          <p style={{ ...dim, margin: "0.5rem 0 0" }} data-testid="agent-capabilities">
            {describeCapabilities(agent.connections)}
          </p>

          {model && (
            <p style={{ ...dim, margin: "0.5rem 0 0" }} data-testid="agent-model">
              {describeModel(model.id, model.clientSupplied)}
            </p>
          )}
        </div>
      </div>
    </GlassPanel>
  );
}

const dim: React.CSSProperties = { color: "var(--wp-text-dim)", fontSize: "0.9rem" };
