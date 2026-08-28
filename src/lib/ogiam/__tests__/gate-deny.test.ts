/**
 * The deny that has never happened.
 *
 * Measured on production 2026-08-27: 4,399 gate decisions, every one an allow.
 * 4,303 in monitor, 96 enforced. Not a single deny, ever.
 *
 * So the allow path is proven by four thousand repetitions and the refusal
 * path, which is the one this product is sold on, is proven by nothing. That
 * is not evidence the gate is permissive. It is the absence of evidence either
 * way, and the two are easy to confuse when a dashboard reports 4,399 governed
 * actions.
 *
 * WHAT IS AND IS NOT COVERED HERE. The ledger WRITE is already proven by those
 * 4,399 rows, so it needs no new test. What has never executed is the decision
 * itself coming back as a refusal, and that is pure: rules over an action,
 * no database. Asserting it here rather than in a *.db.test.ts means it runs
 * in the ordinary unit suite on every PR instead of only where Postgres is.
 *
 * Worth recording for whoever tries this against a local database later:
 * normalizeDatabaseUrlSsl rewrites every connection string to
 * sslmode=verify-full, including localhost, so the pool cannot reach a
 * throwaway container at all. That is a deliberate choice about production
 * safety and it makes pool-backed local testing impossible by design.
 */
import { authorize } from "@/lib/ogiam/authorize";

/* A real-looking credential. The rule keys on the shape, so a stand-in like
   "secret123" would not trigger it and the test would pass for the wrong
   reason. */
const SECRET = "sk-live-51H8xQ2eZvKYlo2CkQ9m4bYtRfGh7JpLmNoPqRsTuVwXyZ0123456";

const principal = {
  kind: "ai_agent" as const,
  agent: "test.agent",
  onBehalfOfUserId: "u-owner",
  onBehalfOfRole: "cto",
  workspaceId: "ws-deny",
};

const carryingASecret = (mode: "enforce" | "monitor") => ({
  principal,
  tool: "draft_email",
  capability: "mail.send",
  isMutation: true,
  surface: "test",
  params: { body: `here is the key ${SECRET}` },
  mode,
});

/* A READ. Written first as a mutation carrying ordinary text, which came back
   "escalate" rather than "allow": a state-changing action is judged on more
   than its parameters, so it was never a control case for "the rule is not
   simply refusing everything". */
const ordinary = (mode: "enforce" | "monitor") => ({
  principal,
  tool: "find_documents",
  capability: "brain.read",
  isMutation: false,
  surface: "test",
  params: { query: "an ordinary sentence with nothing sensitive in it" },
  mode,
});

/* No database. recordDecision returns null early without DATABASE_URL, which
   is the documented shadow-mode path and leaves the decision itself intact. */
const savedDbUrl = process.env.DATABASE_URL;
beforeAll(() => {
  delete process.env.DATABASE_URL;
});
afterAll(() => {
  if (savedDbUrl !== undefined) process.env.DATABASE_URL = savedDbUrl;
});

describe("the gate refuses a credential", () => {
  it("returns a deny, naming the rule that fired", async () => {
    const decision = await authorize(carryingASecret("enforce"));
    expect(decision.intendedOutcome).toBe("deny");
    expect(decision.ruleId).toBe("R-SECRET-DENY");
  });

  it("marks it blocking", async () => {
    const decision = await authorize(carryingASecret("enforce"));
    expect(decision.wouldBlock).toBe(true);
  });

  /* Enforce is what makes a deny mean anything, and the production split is
     the reason to assert both: 96 enforced against 4,303 monitored. A verdict
     computed in monitor is real and deliberately not acted on. */
  it("computes the same verdict in monitor without enforcing it", async () => {
    const decision = await authorize(carryingASecret("monitor"));
    expect(decision.intendedOutcome).toBe("deny");
    expect(decision.wouldBlock).toBe(true);
    expect(decision.enforced).toBe(false);
  });

  it("enforces it in enforce mode", async () => {
    const decision = await authorize(carryingASecret("enforce"));
    expect(decision.enforced).toBe(true);
  });

  /* Without this the suite would pass against a gate that refuses everything,
     which is not a working gate either.

     MONITOR, deliberately. With no ledger reachable, enforce mode blocks every
     action including this one, and that is correct: see the fail-closed test
     below. Asserting the allow here in enforce mode would be asserting the
     wrong thing. */
  it("still allows an ordinary read", async () => {
    const decision = await authorize(ordinary("monitor"));
    expect(decision.intendedOutcome).toBe("allow");
    expect(decision.wouldBlock).toBe(false);
  });

  /* FOUND WHILE WRITING THIS SUITE, and worth keeping. With no ledger to write
     to, an ordinary allow comes back blocking in enforce mode. That is the
     fail-closed-on-unauditable rule: for a governed agent the audit IS the
     guarantee, so an action that cannot be recorded must not run. The monitor
     path is deliberately untouched by it. */
  it("refuses an otherwise-allowed action when it cannot be recorded", async () => {
    const decision = await authorize(ordinary("enforce"));
    expect(decision.intendedOutcome).toBe("allow");
    expect(decision.wouldBlock).toBe(true);
  });

  it("does not apply that rule to the monitor path", async () => {
    const decision = await authorize(ordinary("monitor"));
    expect(decision.wouldBlock).toBe(false);
  });

  /* The refusal has to be attributable. A deny nobody can trace to an actor
     is not an audit record. */
  it("names who was refused", async () => {
    const decision = await authorize(carryingASecret("enforce"));
    expect(decision.reason).toMatch(/secret|credential/i);
  });

  /* THE SECRET MUST NOT TRAVEL WITH THE REFUSAL. The rule fires because a
     credential was in the parameters, so a decision object carrying them
     verbatim would spread the thing it just refused into logs and analytics. */
  it("does not carry the secret in the decision it returns", async () => {
    const decision = await authorize(carryingASecret("enforce"));
    expect(JSON.stringify(decision)).not.toContain(SECRET);
  });
});
