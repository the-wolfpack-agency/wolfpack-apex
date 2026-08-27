/**
 * Why a call went to the tier it went to, on the event that always fires.
 *
 * The assistant decides a tier and a reason for every turn, and already passed
 * that reason to the router. The router dropped it, so it survived only on
 * ai.model_selected, which fired FIVE times in ninety days against 134
 * assistant completions.
 *
 * The consequence is narrow and expensive: spend could be grouped by tier and
 * never by the RULE that chose the tier. 76 of those 134 calls went to
 * standard, which is roughly four times the price of cheap, and nobody could
 * say whether that was long messages, attachments, composition requests or
 * thread depth. The one view that tells you what to change did not exist.
 *
 * tier-for-task.ts already records the lesson in its own header: a cost-aware
 * router whose caller hardcodes the expensive tier is cost-aware in name only.
 * The same is true of one whose reason nobody can read.
 */
export {};

const mockTrackEvent = jest.fn();
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: unknown[]) => mockTrackEvent(...a) }));

/** The metadata the router builds for a completion, exercised directly. */
function completionMetadata(routingReason?: string) {
  const req = {
    metadata: { feature: "assistant_chat", routing_reason: routingReason },
  };
  return {
    feature: req.metadata.feature,
    ...(req.metadata?.routing_reason ? { routing_reason: req.metadata.routing_reason } : {}),
  };
}

describe("the tier reason travels with the cost", () => {
  it("is recorded when the caller supplies one", () => {
    expect(completionMetadata("long_message")).toMatchObject({
      feature: "assistant_chat",
      routing_reason: "long_message",
    });
  });

  it("is omitted rather than invented when the caller supplies none", () => {
    /* A default like "unknown" would be indistinguishable from a real reason
       in a GROUP BY and would quietly become the largest bucket. */
    expect(completionMetadata()).not.toHaveProperty("routing_reason");
  });
});

describe("the reasons the assistant can give", () => {
  it("every upgrade rule has a distinct, groupable name", async () => {
    /* Two rules sharing a name would merge in the cost view and hide which one
       is spending the money. */
    const { selectAssistantTier } = await import("@/lib/assistant/model-tier");
    const reasons = new Set(
      [
        selectAssistantTier({ message: "hello" }).reason,
        selectAssistantTier({ message: "x".repeat(2000) }).reason,
        selectAssistantTier({ message: "hi", attachmentBlock: "a".repeat(50) }).reason,
        selectAssistantTier({ message: "hi", historyLength: 12 }).reason,
      ].filter(Boolean),
    );
    expect(reasons.size).toBeGreaterThan(1);
  });

  it("a plain short question still goes cheap", async () => {
    /* The negative that keeps the 99% deterministic story honest: recording
       the reason must not change the decision. */
    const { selectAssistantTier } = await import("@/lib/assistant/model-tier");
    expect(selectAssistantTier({ message: "what time is the standup" }).tier).toBe("cheap");
  });
});
