/**
 * Agent reasoning fallback.
 *
 * DETERMINISTIC-FIRST still holds: this only runs when NO deterministic tool
 * matched an instruction. Instead of failing the run at zero tokens (the old
 * behavior), the agent reasons about the instruction with the governed LLM so
 * open-ended objectives ("break down the popular agents...") produce a real,
 * useful result.
 *
 * Governed, not a free-for-all:
 *   - goes through the single AI router chokepoint (per-workspace budget gate +
 *     cost analytics + provider failover),
 *   - carries `apply_constitution` so the OGIAM Agent Constitution shapes it,
 *   - is READ-ONLY (produces text, no side effect), so it needs no OGIAM
 *     mutation gate; the executor records + audits the step.
 *
 * Fails soft: if no AI provider is configured, the budget is exceeded, or the
 * provider is down, it returns { ok: false } and the executor records the step
 * as no_match exactly as before. It never throws into the run loop.
 */

import { getAIClient } from "@/lib/ai";

export interface ReasonInput {
  instruction: string;
  agentId: string;
  role: string;
  workspaceId: string;
  /** Task-template guidance (success criteria, context, target), if any. */
  guidance?: string;
  /** Earlier step outputs to reason over (result-chaining). */
  priorResults?: { instruction: string; result: string }[];
}

export type ReasonResult =
  | { ok: true; answer: string }
  | { ok: false; detail: string };

/** True when at least one AI provider is configured. Cheap short-circuit so a
 *  run in an environment with no AI keys never attempts a provider call. */
function aiConfigured(): boolean {
  return Boolean(
    process.env.ANTHROPIC_API_KEY ||
      (process.env.AZURE_OPENAI_API_KEY && process.env.AZURE_OPENAI_ENDPOINT),
  );
}

const SYSTEM_PROMPT =
  "You are an OGIAM agent executing one step of an assigned task. No deterministic " +
  "tool matched this instruction, so reason about it directly and return a concise, " +
  "useful result the requester can act on. Be accurate and grounded; never invent " +
  "facts, sources, or figures. If you cannot answer well, say what you would need.";

export async function reasonAboutInstruction(input: ReasonInput): Promise<ReasonResult> {
  if (!aiConfigured()) {
    return { ok: false, detail: "no AI provider configured for reasoning" };
  }
  try {
    const contextParts: string[] = [];
    if (input.guidance) contextParts.push(input.guidance);
    if (input.priorResults && input.priorResults.length > 0) {
      contextParts.push(
        "Earlier results in this task:\n" +
          input.priorResults.map((p) => `- ${p.instruction}: ${p.result}`).join("\n"),
      );
    }
    const userContent =
      contextParts.length > 0
        ? `${contextParts.join("\n\n")}\n\nInstruction: ${input.instruction}`
        : input.instruction;

    const client = getAIClient();
    const resp = await client.complete({
      messages: [{ role: "user", content: userContent }],
      system: SYSTEM_PROMPT,
      max_tokens: 1024,
      model_tier: "standard",
      latency_target: "real_time",
      // Reasoning is governed by the OGIAM Agent Constitution.
      apply_constitution: true,
      metadata: {
        feature: "agent_reasoning",
        user_id: input.agentId,
        user_role: input.role,
        workspace_id: input.workspaceId,
      },
    });
    const answer = (resp.content ?? "").trim();
    if (!answer) return { ok: false, detail: "reasoning returned no content" };
    return { ok: true, answer };
  } catch (err) {
    // Budget exceeded (typed refusal), provider down, etc. -> degrade to no_match.
    return { ok: false, detail: `reasoning unavailable: ${(err as Error).message}` };
  }
}
