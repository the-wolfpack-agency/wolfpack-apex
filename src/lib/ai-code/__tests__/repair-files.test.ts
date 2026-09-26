/**
 * Files-native repair: author -> gate -> on a block, re-author (different lineage)
 * -> re-gate, bounded. Clean when it passes, needs_human when it cannot, never a
 * loop forever. The gate decision is injected so this is pure.
 */
import { remediateFileChanges, repairBrief } from "../repair-files";
import type { ChangeAssessment } from "../assess";
import type { AuthorFilesResult } from "../author";
import type { FileChange } from "../file-changes";

const clean = (): ChangeAssessment => ({ securityOutcome: "allow", invariantRuleId: "R-MUTATION-ALLOW", invariantBlocked: false, deepScanCritical: 0, deepScanBlocking: false, handoffAllowed: true, blockedBy: null });
const blocked = (by: ChangeAssessment["blockedBy"]): ChangeAssessment => ({ securityOutcome: by === "security" ? "block" : "allow", invariantRuleId: by === "invariant" ? "R-DEPENDENCY-ADDED-ESCALATE" : "R-MUTATION-ALLOW", invariantBlocked: by === "invariant", deepScanCritical: by === "deep-scan" ? 1 : 0, deepScanBlocking: by === "deep-scan", handoffAllowed: false, blockedBy: by });

const files = (marker: string): FileChange[] => [{ path: "src/x.ts", content: `export const x = ${marker};` }];
const authored = (over: Partial<AuthorFilesResult> = {}): AuthorFilesResult => ({ changes: files("2"), author: "model-b", provider: "foundry", costUsd: 0.001, latencyMs: 100, error: null, ...over });

test("passes straight through when the first authored files clear the gate", async () => {
  const res = await remediateFileChanges({
    initial: files("1"), initialAuthor: "model-a",
    reauthor: async () => authored(),
    assess: async () => clean(),
  });
  expect(res.status).toBe("clean");
  expect(res.attempts).toHaveLength(0);
});

test("re-authors on a block and clears on the next attempt (auto-fix)", async () => {
  let call = 0;
  const res = await remediateFileChanges({
    initial: files("bad"), initialAuthor: "model-a",
    reauthor: async () => authored({ changes: files("fixed") }),
    // first assessment blocks (security), second (after re-author) clears
    assess: async () => (++call === 1 ? blocked("security") : clean()),
  });
  expect(res.status).toBe("clean");
  expect(res.author).toBe("model-b"); // repaired by a different lineage
  expect(res.attempts).toHaveLength(1);
  expect(res.changes[0].content).toContain("fixed");
});

test("gives up to a human after maxAttempts, never loops forever", async () => {
  const res = await remediateFileChanges({
    initial: files("bad"), initialAuthor: "model-a",
    reauthor: async () => authored({ changes: files("still-bad") }),
    assess: async () => blocked("invariant"), // never clears
    maxAttempts: 2,
  });
  expect(res.status).toBe("needs_human");
  expect(res.attempts).toHaveLength(3); // initial + 2 re-authors
  expect(res.reason).toMatch(/invariant/);
});

test("stops at the human when the re-author produces nothing usable", async () => {
  const res = await remediateFileChanges({
    initial: files("bad"), initialAuthor: "model-a",
    reauthor: async () => authored({ changes: [], error: "NoProviderAvailableError" }),
    assess: async () => blocked("security"),
  });
  expect(res.status).toBe("needs_human");
  expect(res.reason).toMatch(/no usable change/);
});

describe("repairBrief", () => {
  it("names the blocking layer without leaking instructions", () => {
    expect(repairBrief(blocked("security"))).toMatch(/security gate/i);
    expect(repairBrief(blocked("invariant"))).toMatch(/invariant/i);
    expect(repairBrief(blocked("deep-scan"))).toMatch(/secret/i);
  });
});
