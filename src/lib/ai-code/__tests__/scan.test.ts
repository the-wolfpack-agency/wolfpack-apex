/**
 * AI-code review orchestrator: real detect + gate over a diff, persists via the
 * store (mocked), returns findings + verdict + id. A clean diff allows; a diff
 * that adds a hardcoded secret blocks.
 */

const mockRecord = jest.fn();
jest.mock("../store", () => ({ recordReview: (...a: unknown[]) => mockRecord(...a) }));

import { runCodeReview } from "../scan";

const wrap = (added: string) =>
  `diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1,0 +1,1 @@\n+${added}`;

beforeEach(() => {
  jest.resetAllMocks();
  mockRecord.mockResolvedValue("acr_abc");
});

test("a diff that adds a hardcoded secret is BLOCKED and persisted", async () => {
  const res = await runCodeReview({
    workspaceId: "w-1",
    ref: "PR-42",
    author: "cursor",
    diff: wrap(`const key = "sk-ant-abcdefghijklmnopqrstuvwx0123";`),
    nowIso: "2026-06-29T00:00:00.000Z",
  });
  expect(res.verdict.outcome).toBe("block");
  expect(res.findings[0].klass).toBe("secret");
  expect(res.bySeverity.critical).toBe(1);
  expect(res.id).toBe("acr_abc");
  expect(mockRecord).toHaveBeenCalledWith("w-1", expect.objectContaining({ ref: "PR-42", author: "cursor" }), "2026-06-29T00:00:00.000Z");
});

test("a diff with a high finding ESCALATES", async () => {
  const res = await runCodeReview({ workspaceId: "w", ref: "PR-1", author: "a", diff: wrap("eval(input);"), nowIso: "t" });
  expect(res.verdict.outcome).toBe("escalate");
});

test("a clean diff is ALLOWED with no findings", async () => {
  const res = await runCodeReview({ workspaceId: "w", ref: "PR-2", author: "a", diff: wrap("export const sum = (a, b) => a + b;"), nowIso: "t" });
  expect(res.verdict.outcome).toBe("allow");
  expect(res.findings).toEqual([]);
});
