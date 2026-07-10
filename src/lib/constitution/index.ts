/**
 * OGIAM Agent Constitution — apex accessor.
 *
 * The canonical, machine-readable constitution lives in AgenticQA-core
 * (agenticqa_core/constitution). `generated.ts` is a committed, codegen'd copy
 * (see scripts/sync-constitution.mjs) so it bundles on Vercel. This module is
 * the single place apex code reads the constitution or applies it to an AI
 * request, so no call site hard-codes the rules.
 *
 * The constitution is injected into an AI request ONLY when the request opts in
 * (`apply_constitution: true`), so the 18 other AI call sites are unaffected and
 * we never bloat cheap, high-volume completions. The assistant and OGIAM agent
 * surfaces opt in; that is what makes the rules follow the operator across
 * every session and every agent, independent of model version.
 */

import type { AICompleteRequest } from "@/lib/ai/types";
import { CONSTITUTION_MARKDOWN, CONSTITUTION_VERSION } from "./generated";

export { CONSTITUTION_VERSION };

/** The raw constitution markdown (the human-readable AGENTS.md). */
export function getConstitution(): string {
  return CONSTITUTION_MARKDOWN;
}

/** The constitution with a short, imperative preamble for a system prompt. */
export function renderConstitutionPreamble(): string {
  return (
    `# OGIAM Agent Constitution v${CONSTITUTION_VERSION}\n` +
    `These are the operative engineering rules for this action. They are ` +
    `governance, not suggestions. Follow them exactly.\n\n` +
    CONSTITUTION_MARKDOWN
  );
}

/**
 * Prepend the constitution to an AI request's system prompt when the request
 * opts in. Pure: returns a new request, never mutates. A no-op (returns the
 * same reference) when the request did not opt in.
 */
export function applyConstitutionToRequest(
  req: AICompleteRequest,
): AICompleteRequest {
  if (!req.apply_constitution) return req;
  const preamble = renderConstitutionPreamble();
  const system =
    req.system && req.system.trim().length > 0
      ? `${preamble}\n\n---\n\n${req.system}`
      : preamble;
  return { ...req, system };
}
