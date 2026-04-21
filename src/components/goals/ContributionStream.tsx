"use client";

/**
 * ContributionStream — last-7-days stream of contributions for ONE KR.
 *
 * Shows one row per contribution with:
 *   - source icon (manual / ms_event / ms_task / commit)
 *   - author, short description
 *   - grade pill (hit/miss/close) if graded
 *
 * Non-graded rows rendered in a muted state so graders know what still
 * needs attention.
 */

import type { ContributionView } from "./types";

const SOURCE_ICON: Record<string, string> = {
  manual: "✎",
  ms_event: "📅",
  ms_task: "✓",
  commit: "⌥",
};

const GRADE_COLOR: Record<string, string> = {
  hit: "var(--wp-success)",
  close: "var(--wp-gold)",
  miss: "var(--wp-error)",
};

export interface ContributionStreamProps {
  kr_id: string;
  contributions: ContributionView[];
  /** Map user_id → display name. Falls back to raw id. */
  userNames?: Record<string, string>;
  emptyHint?: string;
}

export default function ContributionStream({
  kr_id,
  contributions,
  userNames,
  emptyHint,
}: ContributionStreamProps) {
  if (contributions.length === 0) {
    return (
      <div
        className="text-xs py-2"
        style={{ color: "var(--wp-text-muted)" }}
        data-testid={`stream-empty-${kr_id}`}
      >
        {emptyHint ?? "No activity in the last 7 days."}
      </div>
    );
  }

  return (
    <ul className="space-y-1.5" data-testid={`stream-${kr_id}`}>
      {contributions.map((c) => (
        <li
          key={c.id}
          className="flex items-start gap-2 text-xs"
          style={{ color: "var(--wp-text)" }}
        >
          <span
            aria-hidden
            className="inline-block w-4 text-center"
            style={{ color: "var(--wp-text-muted)" }}
          >
            {SOURCE_ICON[c.source] ?? "•"}
          </span>
          <span className="flex-1 min-w-0">
            <span className="font-medium">
              {userNames?.[c.user_id] ?? c.user_id}
            </span>{" "}
            <span style={{ color: "var(--wp-text-dim)" }}>{c.description}</span>
          </span>
          {c.graded_as && (
            <span
              className="uppercase tracking-wide px-1.5 py-0.5 rounded text-[10px] font-semibold"
              style={{
                background: `${GRADE_COLOR[c.graded_as]}20`,
                color: GRADE_COLOR[c.graded_as],
              }}
            >
              {c.graded_as}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}
