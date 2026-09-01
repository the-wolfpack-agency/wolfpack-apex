"use client";

/**
 * CommitmentsSidebar — "My commitments this week" form + list.
 *
 * - Shows the user's commitments for the current week (`week_of`).
 * - 1–3 bets input form (textarea + KR picker).
 * - Each committed row has a Friday-grade control (hit/miss/close).
 * - Every write routes through goals-offline so a flaky network queues
 *   instead of dropping commits on the floor.
 *
 * Offline UX: an explicit pill when the queue has pending commits so
 * the user knows submissions will replay on reconnect.
 */

import { useEffect, useState } from "react";
import type { ContributionView, KrView } from "./types";
import {
  sendCommitmentOffline,
  sendGradeOffline,
  GOAL_COMMITMENTS_ENDPOINT,
} from "@/lib/goals-offline";
import { useOfflineQueue } from "@/lib/hooks/useOfflineQueue";

type Grade = NonNullable<ContributionView["graded_as"]>;
const GRADES: Grade[] = ["hit", "close", "miss"];

export interface CommitmentsSidebarProps {
  week_of: string;
  /** Flat list of every active KR across all OKRs — used by the picker. */
  krs: KrView[];
  /** Only the commitments belonging to the current user. */
  myCommitments: ContributionView[];
  onOptimizticAdd?: (row: ContributionView) => void;
  onOptimizticGrade?: (id: string, grade: ContributionView["graded_as"]) => void;
}

export default function CommitmentsSidebar({
  week_of,
  krs,
  myCommitments,
  onOptimizticAdd,
  onOptimizticGrade,
}: CommitmentsSidebarProps) {
  const { pendingCount } = useOfflineQueue(GOAL_COMMITMENTS_ENDPOINT, "POST", {
    resourceType: "goal_commitment",
  });

  const [krId, setKrId] = useState<string>(krs[0]?.id ?? "");
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);

  useEffect(() => {
    if (!krId && krs.length > 0) setKrId(krs[0].id);
  }, [krs, krId]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!krId || !description.trim() || submitting) return;
    if (myCommitments.length >= 3) {
      setFlash("Max 3 bets per week — grade an existing one first.");
      return;
    }
    setSubmitting(true);
    try {
      const res = await sendCommitmentOffline({
        kr_id: krId,
        description: description.trim(),
        committed_for_week: week_of,
      });
      if (res.status === "sent") {
        setFlash("Logged.");
      } else {
        setFlash("Offline — will send on reconnect.");
      }
      if (onOptimizticAdd) {
        onOptimizticAdd({
          id: res.id,
          user_id: "me",
          kr_id: krId,
          source: "manual",
          description: description.trim(),
          committed_for_week: week_of,
          committed_at: new Date().toISOString(),
          graded_as: null,
        });
      }
      setDescription("");
    } catch {
      setFlash("Failed to log. Try again.");
    }
    setSubmitting(false);
  }

  async function handleGrade(
    row: ContributionView,
    grade: ContributionView["graded_as"],
  ) {
    if (!grade) return;
    if (onOptimizticGrade) onOptimizticGrade(row.id, grade);
    try {
      await sendGradeOffline({
        contribution_id: row.id,
        graded_as: grade,
      });
    } catch {
      /* offline wrapper already queues */
    }
  }

  return (
    <aside
      data-testid="commitments-sidebar"
      className="rounded-lg border p-4 space-y-3"
      style={{
        background: "var(--wp-dark-surface)",
        borderColor: "var(--wp-dark-border)",
      }}
    >
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold" style={{ color: "var(--wp-gold)" }}>
          My commitments this week
        </h3>
        {pendingCount > 0 && (
          <span
            data-testid="offline-pending-pill"
            className="text-[10px] px-2 py-0.5 rounded-full"
            style={{ background: "var(--wp-warning)20", color: "var(--wp-warning)" }}
          >
            {pendingCount} queued
          </span>
        )}
      </div>

      <form onSubmit={handleSubmit} className="space-y-2">
        <select
          value={krId}
          onChange={(e) => setKrId(e.target.value)}
          className="w-full rounded border px-2 py-1.5 text-sm"
          style={{
            background: "var(--wp-dark-surface2)",
            borderColor: "var(--wp-dark-border)",
            color: "var(--wp-text)",
          }}
          disabled={krs.length === 0}
          aria-label="Key result"
        >
          {krs.length === 0 ? (
            <option value="">No active KRs</option>
          ) : (
            krs.map((kr) => (
              <option key={kr.id} value={kr.id}>
                {kr.metric}
              </option>
            ))
          )}
        </select>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="I will..."
          rows={2}
          className="w-full rounded border px-2 py-1.5 text-sm resize-none"
          style={{
            background: "var(--wp-dark-surface2)",
            borderColor: "var(--wp-dark-border)",
            color: "var(--wp-text)",
          }}
        />
        <button
          type="submit"
          disabled={submitting || !krId || !description.trim()}
          className="w-full px-3 py-1.5 rounded text-sm font-semibold transition-colors disabled:opacity-50"
          style={{ background: "var(--wp-gold)", color: "var(--wp-dark)" }}
          data-testid="commit-submit"
        >
          {submitting ? "Logging…" : "Log commitment"}
        </button>
        {flash && (
          <p
            className="text-xs"
            style={{ color: "var(--wp-text-muted)" }}
            data-testid="commit-flash"
          >
            {flash}
          </p>
        )}
      </form>

      <ul className="space-y-2 pt-2 border-t" style={{ borderColor: "var(--wp-dark-border)" }}>
        {myCommitments.length === 0 ? (
          <li
            className="text-xs"
            style={{ color: "var(--wp-text-muted)" }}
          >
            No commitments logged yet.
          </li>
        ) : (
          myCommitments.map((c) => (
            <li key={c.id} className="text-xs space-y-1">
              <p style={{ color: "var(--wp-text)" }}>{c.description}</p>
              <div className="flex gap-1">
                {GRADES.map((g) => (
                  <button
                    key={g}
                    onClick={() => handleGrade(c, g)}
                    disabled={c.graded_as === g}
                    data-testid={`grade-${c.id}-${g}`}
                    className="px-1.5 py-0.5 rounded text-[10px] uppercase font-semibold"
                    style={{
                      background:
                        c.graded_as === g
                          ? gradeBg(g)
                          : "var(--wp-dark-surface2)",
                      color:
                        c.graded_as === g
                          ? gradeFg(g)
                          : "var(--wp-text-muted)",
                    }}
                  >
                    {g}
                  </button>
                ))}
              </div>
            </li>
          ))
        )}
      </ul>
    </aside>
  );
}

function gradeBg(g: string): string {
  if (g === "hit") return "var(--wp-success)20";
  if (g === "close") return "var(--wp-gold)20";
  return "var(--wp-error)20";
}
function gradeFg(g: string): string {
  if (g === "hit") return "var(--wp-success)";
  if (g === "close") return "var(--wp-gold)";
  return "var(--wp-error)";
}
