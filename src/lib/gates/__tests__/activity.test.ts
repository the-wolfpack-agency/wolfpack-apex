/**
 * The gate-safety reader aggregates the ai_gate.decision stream into the
 * client-facing summary. The headline metric - dataKeptFromModel (no LLM invoked)
 * - and badChangesPrevented (blocked/escalated with a finding) are the ones that
 * carry the pitch, so they're pinned.
 */
const mockSafeQuery = jest.fn();
jest.mock("@/lib/db", () => ({ safeQuery: (...a: unknown[]) => mockSafeQuery(...a) }));

import { gateSafetySummary } from "@/lib/gates/activity";

beforeEach(() => jest.clearAllMocks());

test("empty for a missing workspace, never queries", async () => {
  expect(await gateSafetySummary(null)).toEqual(expect.objectContaining({ total: 0, dataKeptFromModel: 0, recent: [] }));
  expect(mockSafeQuery).not.toHaveBeenCalled();
});

test("aggregates verdicts, data-kept-from-model, bad-changes-prevented, and frameworks", async () => {
  mockSafeQuery.mockResolvedValue({
    rows: [
      { metadata: { workspace_id: "w1", gate: "safe-review", verdict: "allow", model_invoked: null, frameworks: ["SOC2"], findings: 0, recorded_seq: 10 }, timestamp: "2026-09-28T10:00:00Z" },
      { metadata: { workspace_id: "w1", gate: "safe-review", verdict: "deny", model_invoked: null, frameworks: ["SOC2", "GDPR"], findings: 1, recorded_seq: 11 }, timestamp: "2026-09-28T09:00:00Z" },
      { metadata: { workspace_id: "w1", gate: "ci-autofix", verdict: "auto_fix", model_invoked: "gpt-4o-mini", frameworks: [], findings: 0, recorded_seq: 12 }, timestamp: "2026-09-28T08:00:00Z" },
      { metadata: JSON.stringify({ workspace_id: "w1", gate: "ci-autofix", verdict: "require_human", model_invoked: null, frameworks: ["GDPR"], findings: 2, recorded_seq: 13 }), timestamp: "2026-09-28T07:00:00Z" },
      { metadata: { workspace_id: "w1", gate: "prod-promote", verdict: "require_human", model_used: "", frameworks: "", findings: 0, recorded_seq: 14, preview_url: "https://preview.example" }, timestamp: "2026-09-28T06:00:00Z" },
    ],
  });
  const s = await gateSafetySummary("w1");
  expect(s.awaitingProd).toEqual([{ previewUrl: "https://preview.example", recordedSeq: 14, createdAt: "2026-09-28T06:00:00Z" }]);
  expect(s.recent.find((r) => r.gate === "prod-promote")?.previewUrl).toBe("https://preview.example");
  expect(s.total).toBe(5);
  expect(s.allowed).toBe(1);
  expect(s.autoFixed).toBe(1);
  expect(s.escalatedToHuman).toBe(2);
  // deny+finding AND require_human+finding both count as prevented bad changes
  expect(s.badChangesPrevented).toBe(2);
  // three decisions invoked no model
  expect(s.dataKeptFromModel).toBe(4);
  expect(s.frameworks.sort()).toEqual(["GDPR", "SOC2"]);
  expect(s.recent[0]).toMatchObject({ gate: "safe-review", verdict: "allow", modelInvoked: null, recordedSeq: 10 });
  expect(s.recent[2]).toMatchObject({ verdict: "auto_fix", modelInvoked: "gpt-4o-mini" });
});

test("returns empty summary on a read failure (never throws)", async () => {
  mockSafeQuery.mockResolvedValue({ rows: [] });
  expect(await gateSafetySummary("w1")).toMatchObject({ total: 0, recent: [] });
});
