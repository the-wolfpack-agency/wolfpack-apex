"use client";

/**
 * AgentJourneyTimeline - the agent's path across the surface, chained.
 *
 * Turns the ordered, timestamped trace (JourneyStep[]) into a legible attack
 * narrative: node -> node -> node, each a visit or a signal, colored by how
 * hostile it is, with the decoy trip / payload / probe highlighted so the story
 * reads at a glance ("visited, visited, TRIPPED DECOY, probed /.env"). The raw
 * log was always there; this stops throwing away the order and makes it visual.
 *
 * Pure presentational, theme-aware via --wp-* tokens, CSP-safe (CSS only, no
 * lib). Honeypot/payload nodes pulse unless the viewer prefers reduced motion.
 * Renders nothing when there are no steps (older data degrades gracefully).
 *
 * Enforcement-era steps also carry what the edge DID: "blocked" (turned away)
 * vs "would block" (blocking is off or not on this plan, so it was let through
 * and recorded), the engine's probe label, and the burst rate on a high-rate
 * step. The label maps below are exported so the board names attack families
 * and probes the same way everywhere.
 */
import type { JourneyStep } from "@/lib/agent-behavior";
import { ATTACK_LABEL, attackLabel } from "@/lib/forcefield-web/attack-labels";

type Tone = "muted" | "good" | "warn" | "bad";

const STEP_META: Record<string, { glyph: string; tone: Tone; label: string }> = {
  visit: { glyph: "·", tone: "muted", label: "visited" },
  read_robots: { glyph: "◦", tone: "muted", label: "read robots" },
  read_sitemap: { glyph: "◦", tone: "muted", label: "read sitemap" },
  identified_agent: { glyph: "✓", tone: "good", label: "identified" },
  high_rate: { glyph: "⇈", tone: "warn", label: "high rate" },
  form_too_fast: { glyph: "⚡", tone: "warn", label: "too-fast submit" },
  probed_sensitive: { glyph: "⌖", tone: "warn", label: "probed sensitive" },
  id_enumeration: { glyph: "#", tone: "warn", label: "ID enumeration" },
  runaway_loop: { glyph: "↻", tone: "warn", label: "runaway loop" },
  tripped_decoy: { glyph: "⚠", tone: "bad", label: "TRIPPED DECOY" },
  form_honeypot: { glyph: "⚠", tone: "bad", label: "honeypot field" },
  payload_attack: { glyph: "✳", tone: "bad", label: "payload" },
};

const TONE_COLOR: Record<Tone, string> = {
  muted: "var(--wp-text-muted, #9ca3af)",
  good: "var(--wp-success, #30a46c)",
  warn: "var(--wp-warning, #f5a623)",
  bad: "var(--wp-error, #ef4444)",
};

/** Plain-language payload-family names: one shared map (forcefield-web/attack-labels.ts). */
export { ATTACK_LABEL, attackLabel };

/** Named probe labels the engine emits in props.probe that are not a path. A
 *  path-shaped probe ("/.env") is shown as-is. */
export const PROBE_LABEL: Record<string, string> = {
  next_server_action: "Next.js server action probe",
};
export function probeLabel(probe: string): string {
  if (probe.startsWith("/")) return probe;
  return PROBE_LABEL[probe] ?? probe.replace(/_/g, " ");
}

function metaFor(step: JourneyStep): { glyph: string; tone: Tone; label: string } {
  const m = step.signal ? STEP_META[step.signal] : STEP_META.visit;
  const base = m ?? STEP_META.visit;
  if (step.signal === "payload_attack" && step.attack) {
    return { ...base, label: `payload: ${attackLabel(step.attack)}` };
  }
  if (step.signal === "probed_sensitive" && step.probe && !step.probe.startsWith("/")) {
    return { ...base, label: probeLabel(step.probe) };
  }
  if (step.signal === "high_rate" && typeof step.rate === "number") {
    return { ...base, label: `high rate: ${step.rate} requests` };
  }
  return base;
}

function timeOf(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function AgentJourneyTimeline({ steps, testId = "journey-timeline" }: { steps: readonly JourneyStep[]; testId?: string }) {
  if (!steps || steps.length === 0) return null;
  return (
    <ol className="wp-jt" data-testid={testId} aria-label="Agent path across the surface">
      {steps.map((step, i) => {
        const m = metaFor(step);
        const bad = m.tone === "bad" || step.blocked === true;
        const outcome = step.blocked ? "blocked" : step.wouldBlock ? "would block" : null;
        return (
          <li key={i} className="wp-jt-item">
            {i > 0 && <span className="wp-jt-arrow" aria-hidden>&rarr;</span>}
            <span
              className={`wp-jt-node${bad ? " wp-jt-node--bad" : ""}`}
              data-testid={`${testId}-step-${i}`}
              data-signal={step.signal ?? "visit"}
              data-outcome={outcome ?? undefined}
              title={`${timeOf(step.at)}  ${m.label}  ${step.path}${outcome === "blocked" ? "  (turned away)" : outcome ? "  (let through: blocking is off or not on this plan)" : ""}`}
              style={{ color: TONE_COLOR[m.tone], borderColor: TONE_COLOR[m.tone] }}
            >
              <span className="wp-jt-glyph" aria-hidden>{m.glyph}</span>
              <span className="wp-jt-label">{m.label}</span>
              <span className="wp-jt-path">{step.path}</span>
              {outcome && (
                <span
                  data-testid={`${testId}-step-${i}-outcome`}
                  style={{
                    marginLeft: "0.3rem", fontSize: "0.56rem", fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.04em",
                    padding: "0 0.3rem", borderRadius: 999,
                    color: outcome === "blocked" ? "var(--wp-dark, #0b0d11)" : "var(--wp-warning, #f5a623)",
                    background: outcome === "blocked" ? "var(--wp-error, #ef4444)" : "transparent",
                    border: outcome === "blocked" ? "none" : "1px dashed var(--wp-warning, #f5a623)",
                  }}
                >
                  {outcome}
                </span>
              )}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

export default AgentJourneyTimeline;
