/**
 * The automation backlog summarizer: autonomy rate + escalations ranked by class.
 * Pure, so the ranking that decides what-to-automate-next is reproducible.
 */
import { summarizeAutomationBacklog, type CiFixOutcome } from "@/lib/ai-code/backlog";

const o = (action: string, cls: string, over: Partial<CiFixOutcome> = {}): CiFixOutcome => ({
  action, class: cls, reason: `${cls} reason`, repo: "o/r", ref: "feat-x", createdAt: "2026-09-30T00:00:00Z", ...over,
});

test("empty history -> zeroed, autonomyRate 0 (never NaN)", () => {
  const b = summarizeAutomationBacklog([]);
  expect(b).toMatchObject({ total: 0, autonomous: 0, escalated: 0, autonomyRate: 0, byClass: [], recent: [] });
});

test("autonomy rate = merge_ready / total", () => {
  const b = summarizeAutomationBacklog([o("merge_ready", "lint"), o("merge_ready", "type"), o("escalate_human", "governance"), o("escalate_human", "ambiguous_spec")]);
  expect(b.total).toBe(4);
  expect(b.autonomous).toBe(2);
  expect(b.escalated).toBe(2);
  expect(b.autonomyRate).toBe(0.5);
});

test("escalations rank by class, most-common first (the automation backlog)", () => {
  const b = summarizeAutomationBacklog([
    o("escalate_human", "governance"),
    o("escalate_human", "governance"),
    o("escalate_human", "ambiguous_spec"),
    o("merge_ready", "lint"),
  ]);
  expect(b.byClass).toEqual([
    { class: "governance", count: 2 },
    { class: "ambiguous_spec", count: 1 },
  ]);
  // merge_ready never counts toward the backlog
  expect(b.byClass.find((c) => c.class === "lint")).toBeUndefined();
});

test("recent lists concrete escalation cases with their reason", () => {
  const b = summarizeAutomationBacklog([o("escalate_human", "governance", { ref: "feat-dep", reason: "dependency audit" })]);
  expect(b.recent).toEqual([{ repo: "o/r", ref: "feat-dep", class: "governance", reason: "dependency audit", createdAt: "2026-09-30T00:00:00Z" }]);
});
