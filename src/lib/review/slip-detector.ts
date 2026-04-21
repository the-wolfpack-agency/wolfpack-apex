/**
 * Slip detector — pure, no I/O.
 *
 * A task "slipped" when one of two things is true:
 *
 *   overdue          — dueAt is strictly in the past AND status is not
 *                      "completed". The classic missed-deadline case.
 *
 *   carried_forward  — proxy for "this has been on the list for 3+ days
 *                      and the deadline is now imminent". Fires when the
 *                      task is still "notStarted", was created ≥3 days
 *                      before its dueAt, and the dueAt falls inside the
 *                      next 24h window from `now`.
 *
 * The function flags only — it never mutates. Callers decide how to
 * surface (e.g. Weekly Review card) and whether to fire analytics per
 * slip.
 */
import type { MsTask } from "@/lib/integrations/microsoft-tasks";

export type SlipReason = "overdue" | "carried_forward";

export interface DetectSlipsResult {
  slipped: MsTask[];
  reasons: Record<string, SlipReason>;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function detectSlips(tasks: MsTask[], now: Date = new Date()): DetectSlipsResult {
  const slipped: MsTask[] = [];
  const reasons: Record<string, SlipReason> = {};
  const nowMs = now.getTime();

  for (const t of tasks) {
    if (!t.dueAt) continue;
    const due = Date.parse(t.dueAt);
    if (Number.isNaN(due)) continue;

    // Overdue: dueAt strictly in the past AND not completed.
    // `dueAt === now` is NOT overdue — you still have this instant to complete.
    if (due < nowMs && t.status !== "completed") {
      slipped.push(t);
      reasons[t.id] = "overdue";
      continue;
    }

    // Carried-forward proxy: notStarted + created ≥3 days before dueAt
    // + dueAt within next 24h.
    if (t.status === "notStarted" && due >= nowMs && due - nowMs <= DAY_MS) {
      const created = Date.parse(t.createdAt);
      if (!Number.isNaN(created) && due - created >= 3 * DAY_MS) {
        slipped.push(t);
        reasons[t.id] = "carried_forward";
      }
    }
  }

  return { slipped, reasons };
}
