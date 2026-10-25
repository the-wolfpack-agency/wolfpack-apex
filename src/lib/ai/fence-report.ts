/**
 * fenceForPrompt: fence outside content AND say so when it tried something.
 *
 * Every model call that reads content we did not write (an inbound email, a
 * meeting thread, a CRM note, a tool result, a fetched page, an uploaded file)
 * routes it through the provenance fence in ./provenance. The fence is the
 * defense; the report is how a person finds out that a document tried to give
 * the model orders. Doing both in one call keeps the two from drifting apart,
 * which is what happened when only the assistant emitted the event.
 *
 * Deterministic, no model call. The analytics write is best effort and can
 * never make the caller fail: a broken event pipe must not turn into a broken
 * feature.
 *
 * The build guardrail `src/__tests__/model-call-fence-coverage.test.ts` treats
 * a module that calls this (or fenceUntrusted directly) as fenced.
 */
import { trackEvent } from "@/lib/analytics";
import { fenceUntrusted, type FenceResult, type PromptPart } from "./provenance";

export interface FenceWho {
  userId: string;
  userRole?: string;
}

/** Report directive attempts found by the fence. Never the text itself. */
export function reportFenceAttempts(
  module: string,
  attempts: FenceResult["attempts"],
  who: FenceWho,
): void {
  if (attempts.length === 0) return;
  try {
    trackEvent("ai.injection_attempt_blocked", who.userId, who.userRole ?? "system", {
      module,
      attempts: attempts.length,
      sources: [...new Set(attempts.map((a) => a.provenance))].sort().join(","),
    });
  } catch {
    // silent-ok: the analytics write is best effort; the fence already made the content inert, and a broken event pipe must not fail the model call it reports on
  }
}

/** Fence the parts and report any attempt, in one step. */
export function fenceForPrompt(module: string, parts: PromptPart[], who: FenceWho): FenceResult {
  const fenced = fenceUntrusted(parts);
  reportFenceAttempts(module, fenced.attempts, who);
  return fenced;
}
