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
 */
import type { JourneyStep } from "@/lib/agent-behavior";

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

function metaFor(step: JourneyStep): { glyph: string; tone: Tone; label: string } {
  const m = step.signal ? STEP_META[step.signal] : STEP_META.visit;
  const base = m ?? STEP_META.visit;
  if (step.signal === "payload_attack" && step.attack) {
    return { ...base, label: `payload: ${step.attack.replace(/_/g, " ")}` };
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
        const bad = m.tone === "bad";
        return (
          <li key={i} className="wp-jt-item">
            {i > 0 && <span className="wp-jt-arrow" aria-hidden>&rarr;</span>}
            <span
              className={`wp-jt-node${bad ? " wp-jt-node--bad" : ""}`}
              data-testid={`${testId}-step-${i}`}
              data-signal={step.signal ?? "visit"}
              title={`${timeOf(step.at)}  ${m.label}  ${step.path}`}
              style={{ color: TONE_COLOR[m.tone], borderColor: TONE_COLOR[m.tone] }}
            >
              <span className="wp-jt-glyph" aria-hidden>{m.glyph}</span>
              <span className="wp-jt-label">{m.label}</span>
              <span className="wp-jt-path">{step.path}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

export default AgentJourneyTimeline;
