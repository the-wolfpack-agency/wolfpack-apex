/**
 * runCiFixStep: the closed CI loop. Decides from CI, and on a red CI with budget
 * left, re-authors + commits the fix (injected effects), bounded, never forever.
 */
import { runCiFixStep } from "@/lib/ai-code/ci-fix-driver";
import type { CiSummary } from "@/lib/ai-code/ci-status";

const green: CiSummary = { total: 2, passed: 2, failed: 0, pending: 0, complete: true, ciComplete: true, failedChecks: [], failedDetails: [] };
const red: CiSummary = { total: 2, passed: 1, failed: 1, pending: 0, complete: true, ciComplete: false, failedChecks: ["unit"], failedDetails: [{ name: "unit", summary: "a test failed" }] };
const running: CiSummary = { total: 2, passed: 0, failed: 0, pending: 2, complete: false, ciComplete: false, failedChecks: [], failedDetails: [] };

const changes = [{ path: "src/x.ts", content: "export const x = 2;" }];

test("green CI -> merge_ready, terminal, no fix authored", async () => {
  const reauthor = jest.fn();
  const commit = jest.fn();
  const res = await runCiFixStep({ ci: green, attempt: 0, maxAttempts: 3, reauthor, commit });
  expect(res.decision.action).toBe("merge_ready");
  expect(res.terminal).toBe(true);
  expect(reauthor).not.toHaveBeenCalled();
});

test("running CI -> wait, non-terminal, no fix", async () => {
  const res = await runCiFixStep({ ci: running, attempt: 0, maxAttempts: 3, reauthor: jest.fn(), commit: jest.fn() });
  expect(res.decision.action).toBe("wait");
  expect(res.terminal).toBe(false);
});

test("red CI with budget -> authors + commits the fix, non-terminal (poll again)", async () => {
  const reauthor = jest.fn().mockResolvedValue({ changes, author: "model-b", error: null });
  const commit = jest.fn().mockResolvedValue(["src/x.ts"]);
  const res = await runCiFixStep({ ci: red, attempt: 0, maxAttempts: 3, reauthor, commit });
  expect(reauthor).toHaveBeenCalledWith(expect.stringMatching(/unit/i)); // the brief
  expect(commit).toHaveBeenCalledWith(changes);
  expect(res.fix).toMatchObject({ author: "model-b", files: ["src/x.ts"] });
  expect(res.terminal).toBe(false);
});

test("red CI out of budget -> escalate_human, terminal, no author", async () => {
  const reauthor = jest.fn();
  const res = await runCiFixStep({ ci: red, attempt: 3, maxAttempts: 3, reauthor, commit: jest.fn() });
  expect(res.decision.action).toBe("escalate_human");
  expect(res.terminal).toBe(true);
  expect(reauthor).not.toHaveBeenCalled();
});

test("re-author produces nothing usable -> escalate_human, terminal, no commit", async () => {
  const commit = jest.fn();
  const res = await runCiFixStep({ ci: red, attempt: 0, maxAttempts: 3, reauthor: jest.fn().mockResolvedValue({ changes: [], author: "m", error: "NoProviderAvailableError" }), commit });
  expect(res.decision.action).toBe("escalate_human");
  expect(res.terminal).toBe(true);
  expect(commit).not.toHaveBeenCalled();
});
