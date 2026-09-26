/**
 * Cross-family agent-to-agent handoff, THROUGH the governance layer.
 *
 * The thesis this proves: A2A and MCP move bytes between agents and tools, but
 * neither carries authenticated identity, authorization, provenance, egress
 * control, or an independent correctness check. Those live in a control plane
 * that both protocols assume and neither provides. This router + gate IS that
 * plane. So the interesting demo is not "two agents talk"; it is "agent A hands
 * a task to a DIFFERENT-family agent B, and the layer in between supplies
 * everything that makes the handoff trustworthy, including an independent-family
 * second opinion that removes single-model bias."
 *
 * Flow:
 *   Agent A (the originator, e.g. Claude) composes a prompt.
 *     -> ported into the router, which redacts/egress-checks/budget-governs and
 *        DELIVERS to Agent B pinned to a different family (Azure-hosted here).
 *     -> an independent-family judge (chosen by lineage, not by label) scores
 *        B's answer for soundness. It CANNOT be B's own family - that is the
 *        whole point, and chooseIndependentJudge enforces it.
 *   Returns a single Evidence object: the delivery envelope + the independent
 *   verdict. That object is the pitch.
 *
 * Pure orchestration over the real modules. `complete` is injected so the whole
 * thing unit-tests hermetically; the live CLI passes getAIClient().complete.
 */
import type { AICompleteRequest, AICompleteResponse } from "./types";
import { chooseIndependentJudge, lineageOf, type JudgeCandidate, type Lineage } from "./judge-selection";
import { judgeAnswer, type JudgeVerdict } from "./judge";

/** What actually happened when A handed the task to B. */
export interface DeliveryEvidence {
  delivered: boolean;
  modelUsed: string | null;
  providerUsed: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  latencyMs: number | null;
  answer: string | null;
  /** Honest failure surface: a missing key / unconfigured deployment lands here,
   *  never a thrown exception or a faked success. */
  error: string | null;
}

/** The independent-family second opinion on B's answer. */
export interface IndependentCheckEvidence {
  authorLineage: Lineage;
  judgeLineage: Lineage | null;
  /** True only when the judge is a genuinely different lineage from the author. */
  independent: boolean;
  selectionReason: string;
  judged: boolean;
  verdict: JudgeVerdict | null;
  sound: boolean | null;
  reason: string | null;
  error: string | null;
}

export interface HandoffEvidence {
  agentA: { identity: string; model: string; lineage: Lineage };
  prompt: string;
  agentB: DeliveryEvidence;
  independentCheck: IndependentCheckEvidence;
  /** One-line statement of what the layer supplied that A2A/MCP do not. */
  layerNote: string;
}

export interface HandoffInput {
  prompt: string;
  /** The originator's declared model; only its lineage is used, for narrative. */
  agentAModel?: string;
  agentAIdentity?: string;
  /** Provider name to pin Agent B to (the router knows providers by name). */
  targetProviderPin?: string;
  /** Candidates the independent judge is chosen from. Must include a lineage
   *  different from B's for an independent check to be possible. */
  judgeCandidates?: readonly JudgeCandidate[];
  maxTokens?: number;
  feature?: string;
}

export interface HandoffDeps {
  complete: (req: AICompleteRequest) => Promise<AICompleteResponse>;
}

const DEFAULT_JUDGE_CANDIDATES: readonly JudgeCandidate[] = [
  { provider: "anthropic", model: "claude-sonnet-4-6" },
  { provider: "azure-openai", model: "azure-gpt-4o" },
];

function errText(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return String(e);
}

/**
 * Deliver a task from Agent A to a different-family Agent B through the router,
 * then have an independent-family judge score B's answer. Never throws: a
 * provider that is not configured degrades to a recorded error in the evidence,
 * because "what the layer did and what it could not do" is the honest result.
 */
export async function runCrossFamilyHandoff(input: HandoffInput, deps: HandoffDeps): Promise<HandoffEvidence> {
  const agentAModel = input.agentAModel ?? "claude-opus-4-8";
  const agentAIdentity = input.agentAIdentity ?? "Claude (originator)";
  const targetPin = input.targetProviderPin ?? "azure-openai";
  const maxTokens = input.maxTokens ?? 400;
  const feature = input.feature ?? "a2a-proof";
  const candidates = input.judgeCandidates ?? DEFAULT_JUDGE_CANDIDATES;

  // 1) A -> B, THROUGH the router (redaction / egress / residency / budget all
  //    apply inside complete()). Pinned to a different family than the author.
  const delivery: DeliveryEvidence = {
    delivered: false,
    modelUsed: null,
    providerUsed: null,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
    latencyMs: null,
    answer: null,
    error: null,
  };
  try {
    const resp = await deps.complete({
      messages: [{ role: "user", content: input.prompt }],
      max_tokens: maxTokens,
      model_tier: "standard",
      provider_pin: targetPin,
      metadata: { feature },
    });
    delivery.delivered = true;
    delivery.modelUsed = resp.model_used;
    delivery.providerUsed = resp.provider_used;
    delivery.inputTokens = resp.input_tokens;
    delivery.outputTokens = resp.output_tokens;
    delivery.costUsd = resp.cost_usd;
    delivery.latencyMs = resp.latency_ms;
    delivery.answer = resp.content;
  } catch (e) {
    // silent-ok: not swallowed - recorded to delivery.error and surfaced in the
    // evidence envelope so "B was unreachable" never reads as "B answered".
    delivery.error = errText(e);
  }

  // 2) Choose the independent judge by LINEAGE, off whatever family actually
  //    answered (falls back to the pin's name when delivery failed).
  const authorCandidate: JudgeCandidate = {
    provider: delivery.providerUsed ?? targetPin,
    model: delivery.modelUsed ?? undefined,
  };
  const choice = chooseIndependentJudge(authorCandidate, candidates);

  const check: IndependentCheckEvidence = {
    authorLineage: choice.authorLineage,
    judgeLineage: choice.judgeLineage,
    independent: choice.reason === "independent",
    selectionReason: choice.reason,
    judged: false,
    verdict: null,
    sound: null,
    reason: null,
    error: null,
  };

  // 3) Run the independent judge, pinned to its family, but only when we have an
  //    independent judge AND an answer to check.
  if (choice.candidate && delivery.delivered && delivery.answer) {
    const judgePin = choice.candidate.provider;
    try {
      const result = await judgeAnswer(
        { question: input.prompt, answer: delivery.answer },
        async ({ system, prompt, maxTokens: mt }) => {
          const jr = await deps.complete({
            system,
            messages: [{ role: "user", content: prompt }],
            max_tokens: mt,
            model_tier: "cheap",
            provider_pin: judgePin,
            metadata: { feature: `${feature}-judge`, internal_check: true },
          });
          return jr.content;
        },
      );
      check.judged = result.judged;
      check.verdict = result.verdict;
      check.sound = result.sound;
      check.reason = result.reason;
    } catch (e) {
      // silent-ok: not swallowed - recorded to check.error and surfaced so a
      // judge that could not run never reads as a passed verdict.
      check.error = errText(e);
    }
  } else if (!delivery.delivered) {
    // Report the ROOT cause first: with no answer, independence is moot.
    check.error = "no answer to judge (delivery failed)";
  } else if (!choice.candidate) {
    check.error = `no independent judge available (${choice.reason})`;
  } else {
    check.error = "no answer to judge (empty response)";
  }

  const layerNote =
    "A2A/MCP would have moved the prompt; this layer added identity-scoped routing, " +
    "outbound redaction + egress/residency control, budget governance, and an " +
    "independent-family verdict - none of which either protocol carries.";

  return {
    agentA: { identity: agentAIdentity, model: agentAModel, lineage: lineageOf({ model: agentAModel }) },
    prompt: input.prompt,
    agentB: delivery,
    independentCheck: check,
    layerNote,
  };
}
