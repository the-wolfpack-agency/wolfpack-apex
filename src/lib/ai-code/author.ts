/**
 * The EXECUTOR stage - the front of the code factory.
 *
 * runPipeline governs a diff you hand it; it does not write one. That is why the
 * /admin/ai-code page has, until now, made a human paste a diff. This stage
 * closes the input-to-output loop: a prompt in, a model writes the unified diff,
 * and the diff flows straight into the deterministic gate + independent-family
 * judge + re-route repair that already exist. The model that authors here is
 * recorded so the repairer is guaranteed a DIFFERENT lineage - the same
 * bias-removal rule the judge uses, applied to the fix.
 *
 * Pure orchestration over an injected complete(): unit-tests hermetically, and
 * the route passes getAIClient().complete. Never throws - a model that returns
 * no usable diff is a recorded, empty-diff result the gate then rejects on its
 * own merits, not an exception the caller has to catch.
 */
import type { AICompleteRequest, AICompleteResponse } from "@/lib/ai/types";
import { AI_CODE_AUTHOR_PROMPT } from "@/lib/prompts/definitions/ai-code-author";

export interface AuthorInput {
  /** What to build, in the words a person would use. */
  prompt: string;
  /** Provider to pin the executor to (the router knows providers by name).
   *  Leaving it unset lets the router choose; setting it is how the factory
   *  guarantees a cross-family executor/repairer split. */
  executorProviderPin?: string;
  maxTokens?: number;
  feature?: string;
}

export interface AuthorResult {
  /** The unified diff the executor produced (may be empty - the gate handles that). */
  diff: string;
  /** The model that authored it, as the pipeline's `author`, so the repairer is
   *  chosen to be a different lineage. */
  author: string;
  provider: string | null;
  costUsd: number | null;
  latencyMs: number | null;
  /** Honest failure surface: an unavailable executor lands here, not a throw. */
  error: string | null;
}

export interface AuthorDeps {
  complete: (req: AICompleteRequest) => Promise<AICompleteResponse>;
}

/**
 * Pull the unified diff out of the model's reply. Prefers a ```diff fence, then
 * any fence, then falls back to the raw text if it already looks like a diff.
 * Returns "" when nothing diff-shaped is present, which the gate rejects.
 */
export function extractDiff(reply: string): string {
  const text = (reply ?? "").trim();
  if (!text) return "";
  const fenced = text.match(/```(?:diff|patch)?\s*\n([\s\S]*?)```/);
  const body = (fenced ? fenced[1] : text).trim();
  // It must look like a unified diff, or it is not one.
  if (/^(diff --git |--- |\+\+\+ |@@ )/m.test(body)) return body;
  return "";
}

function errText(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

/**
 * Ask a model to author the diff for a prompt. The returned `author` becomes
 * runPipeline's `author`, guaranteeing the repair stage re-routes to a different
 * lineage on a non-allow gate verdict.
 */
export async function authorDiff(input: AuthorInput, deps: AuthorDeps): Promise<AuthorResult> {
  const maxTokens = input.maxTokens ?? 2000;
  const feature = input.feature ?? "ai-code-author";
  const result: AuthorResult = { diff: "", author: input.executorProviderPin ?? "unknown", provider: null, costUsd: null, latencyMs: null, error: null };
  try {
    const resp = await deps.complete({
      system: AI_CODE_AUTHOR_PROMPT.render({}),
      messages: [{ role: "user", content: input.prompt }],
      max_tokens: maxTokens,
      model_tier: "standard",
      ...(input.executorProviderPin ? { provider_pin: input.executorProviderPin } : {}),
      metadata: { feature },
    });
    result.diff = extractDiff(resp.content);
    // Prefer the concrete model id as the author lineage anchor; fall back to
    // the provider name when the response omits it.
    result.author = resp.model_used || resp.provider_used || result.author;
    result.provider = resp.provider_used;
    result.costUsd = resp.cost_usd;
    result.latencyMs = resp.latency_ms;
  } catch (e) {
    // silent-ok: recorded to result.error and returned, so an unavailable
    // executor reads as "no diff authored", never as a thrown request.
    result.error = errText(e);
  }
  return result;
}
