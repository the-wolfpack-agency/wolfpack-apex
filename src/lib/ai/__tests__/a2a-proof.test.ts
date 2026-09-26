/**
 * The cross-family handoff must: deliver A -> B through the router and record
 * the envelope; pick an independent-family judge (never B's own lineage); attach
 * the verdict; and degrade honestly (recorded error, never a throw or a fake
 * success) when a provider is not configured.
 */
import { runCrossFamilyHandoff, type HandoffDeps } from "../a2a-proof";
import type { AICompleteRequest, AICompleteResponse } from "../types";

function azureAnswer(content: string): AICompleteResponse {
  return {
    content,
    model_used: "azure-gpt-4o",
    provider_used: "azure-openai",
    input_tokens: 42,
    output_tokens: 18,
    cost_usd: 0.00021,
    latency_ms: 640,
  };
}

/** A complete() that answers as Azure for the delivery and as an Anthropic judge
 *  for the internal check, so we can assert on both legs of the handoff. */
function fakeComplete(judgeReply: string): HandoffDeps {
  const calls: AICompleteRequest[] = [];
  const complete = async (req: AICompleteRequest): Promise<AICompleteResponse> => {
    calls.push(req);
    if (req.provider_pin === "anthropic") {
      // the judge leg
      return {
        content: judgeReply,
        model_used: "claude-sonnet-4-6",
        provider_used: "anthropic",
        input_tokens: 30,
        output_tokens: 12,
        cost_usd: 0.00009,
        latency_ms: 300,
      };
    }
    return azureAnswer("Paris is the capital of France.");
  };
  return { complete, ...({ _calls: calls } as object) } as HandoffDeps & { _calls: AICompleteRequest[] };
}

describe("runCrossFamilyHandoff", () => {
  it("delivers A -> B and records the delivery envelope", async () => {
    const ev = await runCrossFamilyHandoff(
      { prompt: "What is the capital of France?" },
      fakeComplete("VERDICT: sound REASON: it answers the question."),
    );
    expect(ev.agentB.delivered).toBe(true);
    expect(ev.agentB.providerUsed).toBe("azure-openai");
    expect(ev.agentB.modelUsed).toBe("azure-gpt-4o");
    expect(ev.agentB.costUsd).toBeGreaterThan(0);
    expect(ev.agentB.answer).toContain("Paris");
  });

  it("chooses an INDEPENDENT-family judge (not B's lineage) and attaches the verdict", async () => {
    const ev = await runCrossFamilyHandoff(
      { prompt: "What is the capital of France?" },
      fakeComplete("VERDICT: sound REASON: coherent and on-topic."),
    );
    // B answered as openai lineage (azure-gpt-4o); judge must be a different family.
    expect(ev.independentCheck.authorLineage).toBe("openai");
    expect(ev.independentCheck.judgeLineage).toBe("anthropic");
    expect(ev.independentCheck.independent).toBe(true);
    expect(ev.independentCheck.judged).toBe(true);
    expect(ev.independentCheck.verdict).toBe("sound");
    expect(ev.independentCheck.sound).toBe(true);
  });

  it("does NOT judge when no independent lineage is available (fail-loud, not fake-pass)", async () => {
    const ev = await runCrossFamilyHandoff(
      // only same-lineage candidates as B -> no independent judge possible
      { prompt: "hi", judgeCandidates: [{ provider: "azure-openai", model: "azure-gpt-4o" }] },
      fakeComplete("VERDICT: sound REASON: x"),
    );
    expect(ev.independentCheck.independent).toBe(false);
    expect(ev.independentCheck.judged).toBe(false);
    expect(ev.independentCheck.selectionReason).toBe("no_independent_lineage_configured");
    expect(ev.independentCheck.error).toMatch(/no independent judge/);
  });

  it("degrades honestly when Agent B is unavailable (records error, never throws)", async () => {
    const deps: HandoffDeps = {
      complete: async (req: AICompleteRequest) => {
        if (req.provider_pin === "anthropic") throw new Error("unreachable in this test");
        throw new Error("NoProviderAvailableError: azure deployment not configured");
      },
    };
    const ev = await runCrossFamilyHandoff({ prompt: "hi" }, deps);
    expect(ev.agentB.delivered).toBe(false);
    expect(ev.agentB.error).toMatch(/not configured/);
    // no answer to judge -> recorded, not crashed
    expect(ev.independentCheck.judged).toBe(false);
    expect(ev.independentCheck.error).toMatch(/delivery failed/);
  });

  it("passes an unreadable judge reply through as unjudged (never a false rejection)", async () => {
    const ev = await runCrossFamilyHandoff(
      { prompt: "What is 2+2?" },
      fakeComplete("this is not the expected format at all"),
    );
    expect(ev.independentCheck.independent).toBe(true);
    expect(ev.independentCheck.judged).toBe(false); // unreadable -> unjudged
    expect(ev.independentCheck.sound).toBe(true); // forgiving in the safe direction
  });
});
