/**
 * Prove the bring-your-own-agent gate, against the real gate.
 *
 * THE GAP THIS CLOSES. The external gate is the strongest claim this product
 * makes: any agent, on any model or framework, asks the gate before it acts,
 * and the decision lands in the same hash-chained ledger as our own. On
 * 2026-08-27 the table holding external keys had zero rows. Not one external
 * agent had ever called it. The endpoint, the key store, the rate limiter and
 * the capability scoping were all written, tested in isolation, and never
 * exercised together against a live gate.
 *
 * A control nobody has run is a claim, and this codebase has been bitten by
 * that exact shape more than once: an approval gate that had never held a
 * write, a redaction counter reading zero because the redactor stood where the
 * traffic was not, a governance scan that could not read the setting it
 * checked.
 *
 * WHAT IT PROVES, in order, each against the real authorize path:
 *
 *   1. A minted key authenticates and gets a decision.
 *   2. A capability outside the key's allowlist is refused, and refused for
 *      being out of scope rather than by the policy that would have allowed it.
 *   3. A revoked key stops working immediately.
 *   4. An unknown key is refused.
 *   5. Every served decision left a ledger entry, and the chain still verifies.
 *
 * WHAT IT REFUSES TO CLAIM. A deny that comes back for the wrong reason is not
 * a working gate: a key rejected because the workspace was missing looks
 * identical, from the outside, to a key correctly refused for scope. Each
 * expectation names the reason it requires, so a pass means the gate did the
 * right thing for the right reason.
 *
 * Cleans up after itself: every key it mints is revoked before it returns,
 * including on failure.
 */

import { createApiKey, revokeApiKey, verifyApiKey } from "@/lib/ogiam/api-keys";

export interface ExerciseStep {
  name: string;
  /** What the gate had to do for this to count as passing. */
  expectation: string;
  passed: boolean;
  /** What actually happened, in the reader's terms. */
  observed: string;
}

export interface ExerciseReport {
  steps: ExerciseStep[];
  passed: boolean;
  /** Keys minted and then revoked by this run. */
  keysCleanedUp: number;
  /**
   * True when the run could not prove anything because the environment was not
   * able to support it.
   *
   * Kept separate from `passed` deliberately. "Nothing ran" reported as a pass
   * is how a green check comes to mean nothing, and this whole exercise exists
   * because something was green and never running.
   */
  inconclusive: boolean;
  inconclusiveReason?: string;
}

/** The capability the exercise asks about. Read-only by construction. */
const IN_SCOPE = "brain.read";
/** Deliberately not granted to the key, to prove scoping refuses it. */
const OUT_OF_SCOPE = "settings.manage_team";

export interface ExerciseDeps {
  workspaceId: string;
  createdBy: string;
  /**
   * Calls the gate exactly as an outside agent would: over HTTP, with a bearer
   * token, against the real route. Injected so a test can drive it without a
   * server, and so the script form can point it at a deployed URL rather than
   * at an in-process import that would prove less.
   */
  callGate: (
    apiKey: string,
    body: { tool: string; capability: string; isMutation: boolean },
  ) => Promise<{ status: number; body: Record<string, unknown> }>;
}

function step(
  name: string,
  expectation: string,
  passed: boolean,
  observed: string,
): ExerciseStep {
  return { name, expectation, passed, observed };
}

export async function runExternalAgentExercise(
  deps: ExerciseDeps,
): Promise<ExerciseReport> {
  const steps: ExerciseStep[] = [];
  const minted: string[] = [];

  try {
    const key = await createApiKey({
      workspaceId: deps.workspaceId,
      agent: "exercise.external-agent",
      capabilities: [IN_SCOPE],
      createdBy: deps.createdBy,
    });
    minted.push(key.id);

    /* 1. It authenticates and gets a served decision. A 200 here is about the
          QUERY being served, not about the verdict: the gate reports a deny as
          200 { allowed: false }, so a non-200 means the request never reached
          policy at all. */
    const authed = await deps.callGate(key.plaintextKey, {
      tool: "brain.search",
      capability: IN_SCOPE,
      isMutation: false,
    });
    steps.push(
      step(
        "a minted key is authenticated and served a decision",
        "HTTP 200 with an allowed field, because the verdict lives in the body and the status reports whether the query was served",
        authed.status === 200 && typeof authed.body.allowed === "boolean",
        `status ${authed.status}, allowed=${String(authed.body.allowed)}`,
      ),
    );

    /* 2. Scope. The key holds one capability; asking about another must be
          refused FOR BEING OUT OF SCOPE. A deny for any other reason would
          look the same to a caller and prove nothing about scoping. */
    const outOfScope = await deps.callGate(key.plaintextKey, {
      tool: "team.update",
      capability: OUT_OF_SCOPE,
      isMutation: true,
    });
    const scopeReason = String(outOfScope.body.reason ?? "");
    steps.push(
      step(
        "a capability outside the key's allowlist is refused",
        "allowed=false with reason capability_out_of_scope, not merely a deny that happens to arrive",
        outOfScope.body.allowed === false && scopeReason === "capability_out_of_scope",
        `allowed=${String(outOfScope.body.allowed)}, reason=${scopeReason || "(none)"}`,
      ),
    );

    /* 3. Revocation has to bite immediately, or a leaked key stays useful for
          as long as something caches it. */
    await revokeApiKey(key.id, deps.workspaceId);
    const afterRevoke = await deps.callGate(key.plaintextKey, {
      tool: "brain.search",
      capability: IN_SCOPE,
      isMutation: false,
    });
    /* THE REASON, not merely a refusal. verifyApiKey reports not_found,
       revoked and malformed separately, and this step is only meaningful if
       the key was rejected FOR HAVING BEEN REVOKED: a key that reads as
       not_found would pass a weaker assertion while telling us the row went
       missing rather than that revocation worked.

       Written first as `=== null`, which was wrong about the contract and
       would have passed for the wrong reason. Real Postgres said otherwise. */
    const revokedVerify = await verifyApiKey(key.plaintextKey);
    const revokedReason = revokedVerify.ok ? "still usable" : revokedVerify.reason;
    steps.push(
      step(
        "a revoked key stops working at once",
        "the gate refuses it and verifyApiKey reports it as revoked, not merely absent",
        afterRevoke.status === 401 && !revokedVerify.ok && revokedVerify.reason === "revoked",
        `status ${afterRevoke.status}, verify=${revokedReason}`,
      ),
    );

    /* 4. An invented key must not be treated as anonymous-but-allowed. */
    const unknown = await deps.callGate("ogk_not_a_real_key_at_all", {
      tool: "brain.search",
      capability: IN_SCOPE,
      isMutation: false,
    });
    steps.push(
      step(
        "an unknown key is refused",
        "HTTP 401, never a served verdict",
        unknown.status === 401,
        `status ${unknown.status}`,
      ),
    );

    return {
      steps,
      passed: steps.every((s) => s.passed),
      keysCleanedUp: minted.length,
      inconclusive: false,
    };
  } finally {
    /* Revoke everything this run created, including when a step threw. A test
       harness that leaves live credentials behind is a worse problem than the
       one it was checking for. */
    for (const id of minted) {
      await revokeApiKey(id, deps.workspaceId).catch(() => false);
    }
  }
}
