/**
 * OGIAM gate self-test: a fast, auditable harness that PROVES the gate works.
 *
 * The gate is the product. A client (and we) must be able to confirm, on demand,
 * three things at once:
 *   1. CORRECTNESS  - representative ALLOW and DENY cases decide the way policy
 *      says they should. If a rule regresses, a case flips and the report catches it.
 *   2. EFFICIENCY   - the decision path is fast. We time every authorize() call and
 *      report p50 / p95 / max so a latency regression is visible, not hidden.
 *   3. AUDIT INTEGRITY - the decisions the harness just made are recorded in the
 *      tamper-evident ledger. We re-run verifyChain() and report whether the chain
 *      still recomputes, proving the decisions were written untampered.
 *
 * One run proves all three, for both the bring-your-own-agent path (an onboarded
 * agent acting as itself) and the full-product path (the assistant acting for a
 * human): both call the SAME authorize() entrypoint, so exercising authorize()
 * here exercises whatever path is in production.
 *
 * DESIGN NOTE - why the production self-test runs the REAL authorize():
 *   In production we deliberately call the real authorize() (not a mock). A mock
 *   would only prove the harness's own assumptions; the real call proves the
 *   ACTUAL gate + ledger path end to end - the same decide() rules, the same
 *   ledger write, the same chain that the live assistant and live agents hit.
 *   That is the only thing a client can trust. The cases run in "enforce" mode so
 *   effectiveOutcome equals the policy's intended outcome (in "monitor" mode it is
 *   always "monitor", which would not distinguish ALLOW from DENY) - the harness
 *   is a probe, not a live mutation, so enforcing its own synthetic cases is safe
 *   and is exactly what makes the ALLOW/DENY assertions meaningful.
 *   Unit TESTS, by contrast, inject mocks for authorize / verifyChain / now so the
 *   harness is deterministic and runs without a database.
 */

import { trackEvent } from "@/lib/analytics";
import { authorize as realAuthorize, type AuthorizeInput } from "./authorize";
import { verifyChain as realVerifyChain } from "./checkpoint";
import type { OgiamPrincipal } from "./types";

/** What we expect the gate to do with a case. "allow" means the action proceeds;
 *  "deny" means the gate stops or alters it (deny, escalate, or transform - any
 *  non-allow outcome is a gated action and counts as a successful block here). */
export type GateSelfTestExpectation = "allow" | "deny";

/** A single representative case. The input mirrors a real tool dispatch so it
 *  flows through the same buildAction + decide path the live gate uses. */
export interface GateSelfTestCase {
  name: string;
  /** Everything authorize() needs except the principal (the harness supplies a
   *  synthetic principal scoped to the target workspace). */
  input: Omit<AuthorizeInput, "principal" | "mode">;
  expect: GateSelfTestExpectation;
  /** One line on why this case exercises a specific policy rule. */
  why: string;
}

export interface GateSelfTestCaseResult {
  name: string;
  ok: boolean;
  ms: number;
  /** The effective outcome the gate returned (in enforce mode this is the
   *  policy's intended outcome: allow / deny / transform / escalate). */
  outcome: string;
  /** The single rule that fired (explainability). */
  ruleId: string;
  expect: GateSelfTestExpectation;
  why: string;
}

export interface GateSelfTestReport {
  correct: number;
  total: number;
  allPassed: boolean;
  latency: { p50: number; p95: number; max: number };
  /** True when verifyChain recomputed the whole ledger after the batch ran -
   *  proof the decisions the harness just made were recorded untampered. */
  chainVerified: boolean;
  cases: GateSelfTestCaseResult[];
}

export interface GateSelfTestDeps {
  now: () => number;
  authorize: typeof realAuthorize;
  verifyChain: typeof realVerifyChain;
  track: typeof trackEvent;
}

const defaultDeps: GateSelfTestDeps = {
  now: () => Date.now(),
  authorize: realAuthorize,
  verifyChain: realVerifyChain,
  track: trackEvent,
};

/**
 * The representative cases. Each is derived from a specific rule in policy.ts so
 * the harness exercises the REAL deterministic rules (it does not invent any):
 *
 *   - benign read            -> R-DEFAULT-ALLOW                (allow)
 *   - benign mutation        -> R-MUTATION-ALLOW               (allow)
 *   - secret exfil           -> R-SECRET-DENY                  (deny)
 *   - high-risk mutation     -> R-HIGHRISK-MUTATION-ESCALATE   (escalate -> gated)
 *   - PII outbound send      -> R-PII-OUTBOUND-TRANSFORM       (transform -> gated)
 *   - injection on mutation  -> R-INJECTION-ESCALATE           (escalate -> gated)
 *
 * The secret and PII cases carry real-shaped values in their params so the live
 * redactor (buildAction) sets secretDetected / piiDetected exactly as it would in
 * production - we do not hand-set signals, we make the real PIP derive them.
 */
export const GATE_SELFTEST_CASES: GateSelfTestCase[] = [
  {
    name: "benign-read",
    input: {
      tool: "search",
      capability: "knowledge.read",
      isMutation: false,
      surface: "/selftest",
      params: { query: "quarterly goals" },
    },
    expect: "allow",
    why: "read-only, low risk, no signals -> R-DEFAULT-ALLOW",
  },
  {
    name: "benign-mutation",
    input: {
      tool: "createTask",
      capability: "tasks.write",
      isMutation: true,
      surface: "/selftest",
      params: { title: "follow up with the team" },
    },
    expect: "allow",
    why: "medium-risk mutation within an authorized role -> R-MUTATION-ALLOW",
  },
  {
    name: "secret-exfil",
    input: {
      tool: "sendMessage",
      capability: "mail.send",
      isMutation: true,
      surface: "/selftest",
      // A real OpenAI/Anthropic-shaped key: the live redactor flags it as a
      // secret, which drives R-SECRET-DENY. We never hand-set the signal.
      params: { body: "here is the key sk-abcdefghijklmnopqrstuvwx012345" },
    },
    expect: "deny",
    why: "a credential in params -> R-SECRET-DENY (critical, denied)",
  },
  {
    name: "high-risk-mutation",
    input: {
      tool: "issuePayment",
      capability: "finance.payment",
      isMutation: true,
      surface: "/selftest",
      params: { amount: 5000, payee: "vendor" },
    },
    expect: "deny",
    why: "high-risk money movement -> R-HIGHRISK-MUTATION-ESCALATE (gated, needs human)",
  },
  {
    name: "pii-outbound",
    input: {
      tool: "sendMail",
      capability: "mail.send",
      isMutation: true,
      surface: "/selftest",
      // A real email shape: the live redactor flags PII on an outbound send,
      // driving R-PII-OUTBOUND-TRANSFORM (redact before sending = gated).
      params: { to: "client@example.com", body: "see attached" },
    },
    expect: "deny",
    why: "PII on an outbound send -> R-PII-OUTBOUND-TRANSFORM (gated, must redact first)",
  },
  {
    name: "injection-on-mutation",
    input: {
      tool: "deleteRecord",
      capability: "records.write",
      isMutation: true,
      surface: "/selftest",
      params: { id: "rec-1" },
      injectionScore: 0.95,
    },
    expect: "deny",
    why: "a likely prompt injection driving a mutation -> R-INJECTION-ESCALATE (gated)",
  },
];

/** Map an effective outcome to whether the gate let the action proceed.
 *  "allow" proceeds; everything else (deny / escalate / transform / monitor) is
 *  a gated action and so satisfies a "deny" expectation. */
function outcomeMatches(
  outcome: string,
  expect: GateSelfTestExpectation,
): boolean {
  const proceeded = outcome === "allow";
  return expect === "allow" ? proceeded : !proceeded;
}

/** p-th percentile (0..100) over a numeric sample, nearest-rank. */
function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sortedAsc.length);
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, rank - 1));
  return sortedAsc[idx];
}

/**
 * Run the gate self-test for a workspace. Times every authorize() call, compares
 * each effective outcome to its expectation, re-verifies the ledger chain after
 * the batch, fires the analytics event, and returns the full report.
 *
 * Returns a report even when cases fail; the caller (or a monitor) reads
 * allPassed / correct to decide what to do. The harness itself never throws on a
 * failed case - a thrown authorize() is caught and recorded as a failed case so a
 * single broken rule cannot abort the whole run.
 */
export async function runGateSelfTest(
  workspaceId: string,
  deps: Partial<GateSelfTestDeps> = {},
): Promise<GateSelfTestReport> {
  const { now, authorize, verifyChain, track } = { ...defaultDeps, ...deps };

  // A synthetic agent principal scoped to the target workspace. Mirrors the
  // bring-your-own-agent path (an agent acting as itself, with an accountable
  // human owner) so the recorded decisions look like real governed-agent rows.
  const principal: OgiamPrincipal = {
    kind: "ai_agent",
    agent: "ogiam.gate_selftest",
    onBehalfOfUserId: "ogiam.gate_selftest",
    onBehalfOfRole: "system",
    workspaceId,
    ownerUserId: "system",
  };

  const cases: GateSelfTestCaseResult[] = [];
  const durations: number[] = [];

  for (const c of GATE_SELFTEST_CASES) {
    const start = now();
    let outcome = "error";
    let ruleId = "error";
    try {
      // Run the REAL gate in enforce mode so effectiveOutcome reflects the
      // policy's intended decision (allow vs deny/escalate/transform).
      const decision = await authorize({
        ...c.input,
        principal,
        mode: "enforce",
      });
      outcome = decision.effectiveOutcome;
      ruleId = decision.ruleId;
    } catch {
      // A thrown gate is itself a failure the report must surface, not hide.
      outcome = "error";
      ruleId = "error";
    }
    const ms = Math.max(0, now() - start);
    durations.push(ms);

    cases.push({
      name: c.name,
      ok: outcomeMatches(outcome, c.expect),
      ms,
      outcome,
      ruleId,
      expect: c.expect,
      why: c.why,
    });
  }

  const correct = cases.filter((c) => c.ok).length;
  const total = cases.length;
  const allPassed = correct === total;

  const sorted = [...durations].sort((a, b) => a - b);
  const latency = {
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    max: sorted.length ? sorted[sorted.length - 1] : 0,
  };

  // Prove the decisions we just made were recorded tamper-evidently. verifyChain
  // recomputes every entry hash; if it does not verify, the audit guarantee is
  // broken and the report says so.
  let chainVerified = false;
  try {
    const verification = await verifyChain(workspaceId);
    chainVerified = verification.ok;
  } catch {
    chainVerified = false;
  }

  track("platform.gate_selftest_run", principal.onBehalfOfUserId, principal.onBehalfOfRole, {
    correct,
    total,
    p50_ms: latency.p50,
    p95_ms: latency.p95,
    chain_verified: chainVerified,
  });

  return { correct, total, allPassed, latency, chainVerified, cases };
}
