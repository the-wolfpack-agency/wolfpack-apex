"use client";

/**
 * FridaySyncView — slim read-only roll-up of everyone's weekly
 * commitments + their grading status. Rendered at the bottom of /goals
 * on Fridays (or always, at the bottom) so the team can run their sync
 * meeting off this one page.
 */

import type { ContributionView } from "./types";

export interface FridaySyncViewProps {
  week_of: string;
  teamCommitments: ContributionView[];
  userNames?: Record<string, string>;
}

export default function FridaySyncView({
  week_of,
  teamCommitments,
  userNames,
}: FridaySyncViewProps) {
  // Group by user_id so the meeting goes person-by-person.
  const byUser = new Map<string, ContributionView[]>();
  for (const c of teamCommitments) {
    const list = byUser.get(c.user_id) ?? [];
    list.push(c);
    byUser.set(c.user_id, list);
  }

  return (
    <section
      data-testid="friday-sync"
      className="rounded-lg border p-4"
      style={{
        background: "var(--wp-dark-surface)",
        borderColor: "var(--wp-dark-border)",
      }}
    >
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold" style={{ color: "var(--wp-gold)" }}>
          Friday sync — week of {week_of}
        </h3>
        <span className="text-xs" style={{ color: "var(--wp-text-muted)" }}>
          {teamCommitments.length} commits · {countGraded(teamCommitments)} graded
        </span>
      </div>
      {byUser.size === 0 ? (
        <p
          className="text-xs mt-3"
          style={{ color: "var(--wp-text-muted)" }}
        >
          No commitments logged for this week yet.
        </p>
      ) : (
        <ul className="mt-3 space-y-3">
          {Array.from(byUser.entries()).map(([userId, commits]) => (
            <li key={userId}>
              <p className="text-xs font-medium" style={{ color: "var(--wp-text)" }}>
                {userNames?.[userId] ?? userId}
              </p>
              <ul className="mt-1 space-y-0.5">
                {commits.map((c) => (
                  <li
                    key={c.id}
                    className="text-xs flex items-start gap-2"
                    style={{ color: "var(--wp-text-dim)" }}
                  >
                    <span aria-hidden>•</span>
                    <span className="flex-1">{c.description}</span>
                    <span
                      className="uppercase tracking-wide text-[10px] font-semibold"
                      style={{
                        color:
                          c.graded_as === "hit"
                            ? "var(--wp-success)"
                            : c.graded_as === "miss"
                              ? "var(--wp-error)"
                              : c.graded_as === "close"
                                ? "var(--wp-gold)"
                                : "var(--wp-text-muted)",
                      }}
                    >
                      {c.graded_as ?? "pending"}
                    </span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function countGraded(rows: ContributionView[]): number {
  return rows.filter((c) => c.graded_as != null).length;
}
