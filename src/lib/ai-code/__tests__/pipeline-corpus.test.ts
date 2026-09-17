/**
 * Adversarial corpus: prove the pipeline ACCEPTS good code, REJECTS bad code,
 * and FLAGS bad process - across every failure mode we know.
 *
 * This is the efficacy proof a buyer asks for ("show me it actually stops the
 * bad stuff"), and a permanent regression guard. It runs the REAL detector +
 * gate + conformance (not mocks), so every verdict is the shipped behavior; only
 * the repair MODEL is injected. A repair that never produces a real fix is used
 * for the bad-code cases, which proves the gate HOLDS even when the model does
 * not help: bad code is never handed off as ready_for_pr.
 */
import { runPipeline } from "../pipeline";
import { reviewDiff } from "../detect";
import { decideCodeGate } from "../gate";
import type { CodeReviewResult } from "../types";
import type { RepairComplete } from "../repair";
import type { JudgeCandidate } from "@/lib/ai/judge-selection";

function realReview(diff: string): Promise<CodeReviewResult> {
  const findings = reviewDiff(diff);
  return Promise.resolve({ ref: "r", author: "a", findings, verdict: decideCodeGate(findings), bySeverity: {} });
}

function fileDiff(path: string, lines: string[]): string {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,1 +1,${lines.length + 1} @@`,
    " existing",
    ...lines.map((l) => `+${l}`),
    "",
  ].join("\n");
}
const combine = (...d: string[]) => d.join("\n");

const AUTHOR = "claude-3-5-sonnet";
const INDEPENDENT: JudgeCandidate[] = [{ model: "gpt-4o-mini", provider: "openai" }];
const NOW = "2026-09-17T00:00:00.000Z";
/** A repair that never yields a real fix (empty -> cheat guard rejects it), so a
 *  bad-code case can only end in needs_human - the gate is never talked past. */
const noFixRepair: RepairComplete = async () => "";

// Reusable pieces.
const UNIT = fileDiff("src/lib/thing/__tests__/thing.test.ts", ["it('works', () => {});"]);
const CONTRACT = fileDiff("src/app/api/thing/__tests__/route.test.ts", ["it('200', () => {});"]);
const E2E = fileDiff("tests/e2e/thing.spec.ts", ["test('flow', async () => {});"]);
const CODE = fileDiff("src/lib/thing/thing.ts", ["export const x = 1;"]);
const CODE_WITH_ANALYTICS = fileDiff("src/lib/thing/thing.ts", ["trackEvent('thing.done', u, r, {});"]);

interface Case {
  name: string;
  diff: string;
  answers: Record<string, string>;
  expect: { status: "ready_for_pr" | "needs_human"; conforms: boolean; deviation?: string };
}

const CORPUS: Case[] = [
  // ---- ACCEPT: good code with the process it committed to ----
  {
    name: "clean feature, full test coverage, analytics wired, reversible",
    diff: combine(UNIT, CONTRACT, E2E, CODE_WITH_ANALYTICS),
    answers: { tests: "all", data: "analytics", reversibility: "reversible" },
    expect: { status: "ready_for_pr", conforms: true },
  },

  // ---- REJECT bad CODE: the security gate stops it, and no repair talks past it ----
  {
    name: "hardcoded secret (critical)",
    diff: fileDiff("src/config.ts", ['const apiKey = "aVerySecretValue12345";']),
    answers: { tests: "unit" },
    expect: { status: "needs_human", conforms: false },
  },
  {
    name: "reset link written to a log (the origin incident)",
    diff: fileDiff("src/auth.ts", ['console.log("password reset:", resetUrl);']),
    answers: { tests: "unit" },
    expect: { status: "needs_human", conforms: false },
  },
  {
    name: "dynamic code execution (eval)",
    diff: fileDiff("src/run.ts", ["eval(req.body.code);"]),
    answers: { tests: "unit" },
    expect: { status: "needs_human", conforms: false },
  },
  {
    name: "TLS verification disabled",
    diff: fileDiff("src/http.ts", ["const agent = new https.Agent({ rejectUnauthorized: false });"]),
    answers: { tests: "unit" },
    expect: { status: "needs_human", conforms: false },
  },

  // ---- FLAG bad PROCESS: gate is clean, but the change breaks its own spec ----
  {
    name: "gate-clean but skips the required test coverage",
    diff: CODE_WITH_ANALYTICS, // no test files
    answers: { tests: "all", data: "analytics" },
    expect: { status: "ready_for_pr", conforms: false, deviation: "tests" },
  },
  {
    name: "gate-clean but does not wire the promised analytics",
    diff: combine(UNIT, CODE), // a test, but no trackEvent
    answers: { tests: "unit", data: "analytics" },
    expect: { status: "ready_for_pr", conforms: false, deviation: "data" },
  },
  {
    name: "gate-clean but adds an unguarded migration where the spec said guarded",
    diff: combine(UNIT, fileDiff("db/migrations/900_x.sql", ["CREATE TABLE t ();"])),
    answers: { tests: "unit", reversibility: "guarded" },
    expect: { status: "ready_for_pr", conforms: false, deviation: "reversibility" },
  },
];

describe("Secure Agent pipeline — adversarial corpus", () => {
  for (const c of CORPUS) {
    it(c.name, async () => {
      const run = await runPipeline({
        ref: "corpus",
        prompt: "task",
        answers: c.answers,
        diff: c.diff,
        author: AUTHOR,
        nowIso: NOW,
        review: realReview,
        repair: noFixRepair,
        candidates: INDEPENDENT,
      });

      expect(run.status).toBe(c.expect.status);
      // Bad code is NEVER handed off ready for a PR.
      if (c.expect.status === "needs_human") {
        expect(run.status).not.toBe("ready_for_pr");
        expect(run.review.verdict.outcome).not.toBe("allow");
      }
      expect(run.conformance.conforms).toBe(c.expect.conforms);
      if (c.expect.deviation) {
        const f = run.conformance.findings.find((x) => x.requirement === c.expect.deviation);
        expect(f?.ok).toBe(false);
      }
    });
  }

  it("covers accept, reject-code, and flag-process (no failure mode left untested)", () => {
    const accepts = CORPUS.filter((c) => c.expect.status === "ready_for_pr" && c.expect.conforms);
    const rejectsCode = CORPUS.filter((c) => c.expect.status === "needs_human");
    const flagsProcess = CORPUS.filter((c) => c.expect.status === "ready_for_pr" && !c.expect.conforms);
    expect(accepts.length).toBeGreaterThanOrEqual(1);
    expect(rejectsCode.length).toBeGreaterThanOrEqual(4);
    expect(flagsProcess.length).toBeGreaterThanOrEqual(3);
  });
});
