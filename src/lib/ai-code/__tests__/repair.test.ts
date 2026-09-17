/**
 * Stage 2 re-route repair loop.
 *
 * The reviewer here is the REAL detector + gate (reviewDiff + decideCodeGate),
 * not a mock, so every assertion is the shipped gate's actual decision: a real
 * hardcoded-secret diff really blocks, a real secret-store diff really passes.
 * Only the repair MODEL is injected, because that is the part with no
 * deterministic answer.
 */
import { remediateDiff, type RepairComplete } from "../repair";
import { reviewDiff } from "../detect";
import { decideCodeGate } from "../gate";
import type { CodeReviewResult } from "../types";
import type { JudgeCandidate } from "@/lib/ai/judge-selection";

/** The shipped detector + gate, wired as the injected reviewer (no DB, no store). */
function realReview(diff: string): Promise<CodeReviewResult> {
  const findings = reviewDiff(diff);
  const verdict = decideCodeGate(findings);
  const bySeverity: Record<string, number> = {};
  for (const f of findings) bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;
  return Promise.resolve({ ref: "ref", author: "author", findings, verdict, bySeverity });
}

/** A minimal, valid unified diff that adds one line to config.ts. */
function makeDiff(addedLine: string): string {
  return [
    "diff --git a/config.ts b/config.ts",
    "--- a/config.ts",
    "+++ b/config.ts",
    "@@ -1,1 +1,2 @@",
    " export const base = 1;",
    `+${addedLine}`,
    "",
  ].join("\n");
}

const BLOCKED = makeDiff('const apiKey = "aVerySecretValue12345";'); // critical -> block
const CLEAN = makeDiff("const apiKey = process.env.API_KEY;"); // no finding -> allow
const STILL_BAD = makeDiff('const authToken = "anotherSecretValue99";'); // critical -> block

const AUTHOR = "claude-3-5-sonnet"; // anthropic lineage
const INDEPENDENT: JudgeCandidate[] = [{ model: "gpt-4o-mini", provider: "openai" }]; // openai lineage
const SAME_FAMILY: JudgeCandidate[] = [{ model: "claude-3-haiku", provider: "anthropic" }];

/** A repair() that returns a fixed sequence of outputs and counts its calls. */
function scriptedRepair(outputs: string[]): RepairComplete & { calls: () => number } {
  let i = 0;
  const fn: RepairComplete = async () => {
    const out = outputs[Math.min(i, outputs.length - 1)];
    i += 1;
    return out;
  };
  return Object.assign(fn, { calls: () => i });
}

describe("remediateDiff", () => {
  it("needs no repair when the diff already passes the gate", async () => {
    const repair = scriptedRepair(["should-not-be-called"]);
    const res = await remediateDiff({
      author: AUTHOR,
      diff: makeDiff("export const y = 2;"),
      review: realReview,
      repair,
      candidates: INDEPENDENT,
    });
    expect(res.status).toBe("clean");
    expect(res.attempts).toHaveLength(0);
    expect(res.repairerLineage).toBeNull();
    expect(repair.calls()).toBe(0);
  });

  it("re-routes a BLOCKED diff and returns clean when the repair passes the gate", async () => {
    const repair = scriptedRepair([CLEAN]);
    const res = await remediateDiff({
      author: AUTHOR,
      diff: BLOCKED,
      review: realReview,
      repair,
      candidates: INDEPENDENT,
    });
    expect(res.status).toBe("clean");
    expect(res.diff).toBe(CLEAN.trim());
    expect(res.attempts).toHaveLength(1);
    expect(res.attempts[0].outcomeBefore).toBe("block");
    expect(res.attempts[0].outcomeAfter).toBe("allow");
    expect(res.attempts[0].accepted).toBe(true);
    // The repairer is a DIFFERENT family than the author.
    expect(res.repairerLineage).not.toBe("anthropic");
    expect(res.repairerLineage).toBe("openai");
    expect(repair.calls()).toBe(1);
  });

  it("the GATE re-checks: a repair that reintroduces a secret is never clean", async () => {
    // The model claims a fix but the rewrite still holds a hardcoded secret.
    const repair = scriptedRepair([STILL_BAD, STILL_BAD]);
    const res = await remediateDiff({
      author: AUTHOR,
      diff: BLOCKED,
      review: realReview,
      repair,
      maxAttempts: 2,
      candidates: INDEPENDENT,
    });
    expect(res.status).toBe("needs_human");
    expect(res.review.verdict.outcome).toBe("block");
    expect(res.attempts).toHaveLength(2);
    expect(res.attempts.every((a) => a.accepted)).toBe(true);
  });

  it("cheat guard: an empty or prose 'repair' is rejected, never passed off as clean", async () => {
    // Deleting the code / answering in prose parses to zero added lines and
    // would otherwise scan clean.
    const repair = scriptedRepair(["", "I have fixed the issue."]);
    const res = await remediateDiff({
      author: AUTHOR,
      diff: BLOCKED,
      review: realReview,
      repair,
      maxAttempts: 2,
      candidates: INDEPENDENT,
    });
    expect(res.status).toBe("needs_human");
    // Both attempts recorded, neither accepted as a real diff.
    expect(res.attempts).toHaveLength(2);
    expect(res.attempts.every((a) => !a.accepted)).toBe(true);
    // The original blocked diff is still what the gate saw last.
    expect(res.review.verdict.outcome).toBe("block");
  });

  it("hands to a human when no independent-family repairer is configured", async () => {
    const repair = scriptedRepair([CLEAN]);
    const res = await remediateDiff({
      author: AUTHOR,
      diff: BLOCKED,
      review: realReview,
      repair,
      candidates: SAME_FAMILY, // only a sibling of the author
    });
    expect(res.status).toBe("needs_human");
    expect(res.repairerLineage).toBeNull();
    expect(res.reason).toMatch(/no independent/i);
    // A same-family model is NEVER asked to fix its own family's mistake.
    expect(repair.calls()).toBe(0);
  });

  it("escalates the model tier across attempts", async () => {
    const repair = scriptedRepair([STILL_BAD, STILL_BAD]);
    const res = await remediateDiff({
      author: AUTHOR,
      diff: BLOCKED,
      review: realReview,
      repair,
      maxAttempts: 2,
      candidates: INDEPENDENT,
    });
    expect(res.attempts[0].tier).toBe("standard");
    expect(res.attempts[1].tier).toBe("premium");
  });

  it("recovers on the SECOND attempt after a bad first repair", async () => {
    const repair = scriptedRepair([STILL_BAD, CLEAN]);
    const res = await remediateDiff({
      author: AUTHOR,
      diff: BLOCKED,
      review: realReview,
      repair,
      maxAttempts: 2,
      candidates: INDEPENDENT,
    });
    expect(res.status).toBe("clean");
    expect(res.diff).toBe(CLEAN.trim());
    expect(res.attempts).toHaveLength(2);
    expect(res.attempts[0].outcomeAfter).toBe("block");
    expect(res.attempts[1].outcomeAfter).toBe("allow");
  });
});
