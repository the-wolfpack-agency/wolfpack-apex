"use client";

/**
 * "Your answer is coming" — a staged indicator, not a static spinner.
 *
 * The assistant answers in one shot (no token streaming), so the wait is 5–7
 * seconds of nothing. A single spinner that looks identical for every question,
 * successful or not, reads as a frozen page. This walks through the phases a
 * grounded answer actually goes through — understanding, searching the library,
 * reading sources, writing — advancing on a timer so the reader can see the
 * request is alive and roughly how far along it is.
 *
 * It is deliberately honest-ish rather than fake precise: the phases are the
 * real stages in order, timed to the typical latency, and the label holds on
 * the last phase ("Writing your answer") until the real response replaces the
 * whole indicator. No percentage is claimed, because the client is not
 * reporting true progress and a fake bar that hits 100% then waits is worse
 * than none.
 *
 * Pure presentation. It knows nothing about the request and cannot affect the
 * answer; the parent unmounts it when the response arrives.
 */

import { useEffect, useState } from "react";

export const THINKING_PHASES = [
  "Understanding your question",
  "Searching your library",
  "Reading the most relevant sources",
  "Writing your answer",
] as const;

export interface AssistantThinkingIndicatorProps {
  /** Override phases (tests). */
  phases?: readonly string[];
  /** Ms between phase advances (tests). */
  intervalMs?: number;
}

export default function AssistantThinkingIndicator({
  phases = THINKING_PHASES,
  intervalMs = 1600,
}: AssistantThinkingIndicatorProps) {
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    // Advance through the phases, then hold on the last one until the parent
    // unmounts us. clamp, never wrap: wrapping back to "Understanding" after
    // "Writing" would read as the request having restarted.
    if (phase >= phases.length - 1) return;
    const t = setTimeout(() => setPhase((p) => Math.min(p + 1, phases.length - 1)), intervalMs);
    return () => clearTimeout(t);
  }, [phase, phases.length, intervalMs]);

  const pct = Math.round(((phase + 1) / phases.length) * 100);

  return (
    <div className="flex justify-start" data-testid="assistant-typing-indicator">
      <div
        className="rounded-xl px-4 py-3 w-full lg:max-w-[85%] min-w-0"
        style={{ background: "var(--wp-dark-surface2, #222)" }}
      >
        <div className="flex items-center gap-2 mb-2.5">
          <div className="flex items-center gap-1.5" aria-hidden>
            <span
              className="w-2 h-2 rounded-full animate-bounce inline-block"
              style={{ background: "var(--wp-gold, #eab308)", animationDelay: "0ms" }}
            />
            <span
              className="w-2 h-2 rounded-full animate-bounce inline-block"
              style={{ background: "var(--wp-gold, #eab308)", animationDelay: "150ms" }}
            />
            <span
              className="w-2 h-2 rounded-full animate-bounce inline-block"
              style={{ background: "var(--wp-gold, #eab308)", animationDelay: "300ms" }}
            />
          </div>
          <span
            className="text-xs font-medium"
            style={{ color: "var(--wp-text-dim, #aaa)" }}
            data-testid="thinking-phase"
            aria-live="polite"
          >
            {phases[phase]}
          </span>
        </div>
        {/* Stage progress — segments, not a fake percentage. One segment per
            phase, filled up to the current stage. */}
        <div className="flex gap-1" aria-hidden data-testid="thinking-progress" data-progress={pct}>
          {phases.map((label, i) => (
            <span
              key={label}
              className="h-1 flex-1 rounded-full transition-colors"
              style={{
                background:
                  i <= phase ? "var(--wp-gold, #eab308)" : "var(--wp-dark-border, #333)",
              }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
