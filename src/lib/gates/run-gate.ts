/**
 * runGate - the framework wrapper every gate is invoked through.
 *
 * It does the cross-cutting work so no gate author has to (and cannot get it
 * wrong):
 *  1. Enforces the client's data policy by handing the gate a POLICY-ENFORCED
 *     agent: `none` -> the agent refuses (no data ever leaves); `redacted` ->
 *     prompts are scrubbed of the client's patterns before the model sees them;
 *     `full` -> passed through. A gate physically cannot bypass this.
 *  2. Stamps the client's compliance frameworks onto the transparency record.
 *  3. Computes the canonical hash-chained audit payload uniformly.
 *
 * Persistence (analytics + OGIAM ledger) is the caller's job (the route), so the
 * framework stays pure and testable.
 */
import type { GateAgent, GateContext, GateDefinition, GateResult } from "./types";
import { scrubForModel } from "./scrub";

/** Redact the client's configured patterns from a prompt before it reaches a
 *  model. Invalid regex sources are skipped (never throw from the hot path). */
export function redactPrompt(prompt: string, patterns: readonly string[] | undefined): string {
  if (!patterns || patterns.length === 0) return prompt;
  let out = prompt;
  for (const term of patterns) {
    // LITERAL substring redaction - deliberately NOT a regex. Building a RegExp
    // from a client-provided string is a ReDoS + injection risk (a client could
    // pass a catastrophic-backtracking pattern that hangs the gate). A literal
    // split/join is linear-time and cannot be weaponized. The default scrub
    // (scrubForModel) already covers secret/PII SHAPES we control; client
    // redactions are for specific literal terms (codenames, internal ids).
    if (term) out = out.split(term).join("[REDACTED]");
  }
  return out;
}

/** Wrap the client's agent to enforce `policy.allowModelData`. Returns undefined
 *  when the policy forbids any model use, so the gate sees "no agent available"
 *  and must decide deterministically.
 *
 *  A DEFAULT secret/PII scrub runs on EVERY prompt before it leaves - even under
 *  "full" - because a client who allows model data still never means "send our
 *  keys / a customer's SSN to the LLM". The client's own redactions layer on top. */
export function policyEnforcedAgent(agent: GateAgent | undefined, policy: GateContext["policy"]): GateAgent | undefined {
  if (!agent || policy.allowModelData === "none") return undefined;
  return {
    complete: (req) => {
      // 1) always scrub recognizable secrets/PII, 2) then the client's redactions.
      const scrubbed = scrubForModel(req.prompt).text;
      const prompt = policy.allowModelData === "redacted" ? redactPrompt(scrubbed, policy.redactions) : scrubbed;
      return agent.complete({ ...req, prompt });
    },
  };
}

/** Run a gate under the framework's guarantees. The returned result's
 *  transparency.frameworksApplied always reflects the client's policy, and its
 *  audit payload is uniform across gates. */
export async function runGate<I, O>(
  def: GateDefinition<I, O>,
  input: I,
  ctx: GateContext,
): Promise<GateResult<O>> {
  const enforcedAgent = policyEnforcedAgent(ctx.agent, ctx.policy);
  const result = await def.evaluate(input, { ...ctx, agent: enforcedAgent });

  // The framework owns these fields so a gate can never under-report compliance.
  result.transparency.frameworksApplied = ctx.policy.frameworks;
  if (enforcedAgent === undefined) result.transparency.modelInvoked = null;
  result.audit = {
    gate: def.name,
    verdict: result.verdict,
    ruleId: result.audit?.ruleId ?? `GATE-${def.name}`,
    reason: result.reason,
    workspaceId: ctx.workspaceId,
    actorId: ctx.actorId,
  };
  return result;
}
