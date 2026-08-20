/**
 * Conditional verification AT THE CHOKEPOINT.
 *
 * verification.test.ts proves the policy. This proves the router acts on it,
 * and more importantly that it does NOT act when it should not: the cost case
 * for this whole feature is that the ordinary request pays for exactly one
 * call. A router that quietly retries on every request has inverted the saving
 * it was built to produce, and would look identical in code review.
 */

const mockMessagesCreate = jest.fn();
const mockTrackEvent = jest.fn();

jest.mock("@anthropic-ai/sdk", () => {
  class FakeInternalServerError extends Error {
    status = 500;
    name = "InternalServerError";
  }
  class FakeAPIError extends Error {
    constructor(message: string, public status: number) {
      super(message);
    }
  }
  const Anthropic = jest.fn().mockImplementation(() => ({
    messages: { create: mockMessagesCreate },
  })) as unknown as {
    new (...args: unknown[]): unknown;
    InternalServerError: typeof FakeInternalServerError;
    APIError: typeof FakeAPIError;
  };
  Anthropic.InternalServerError = FakeInternalServerError;
  Anthropic.APIError = FakeAPIError;
  return { __esModule: true, default: Anthropic };
});

jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: unknown[]) => mockTrackEvent(...a),
}));

import { getAIClient, _resetAIClientForTests } from "@/lib/ai/router";

function reply(text: string) {
  return {
    content: [{ type: "text", text }],
    usage: { input_tokens: 10, output_tokens: 5 },
    model: "claude-haiku-4-5",
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  _resetAIClientForTests(null);
  process.env.ANTHROPIC_API_KEY = "test-key";
  delete process.env.AZURE_OPENAI_ENDPOINT;
  delete process.env.AZURE_OPENAI_API_KEY;
  delete process.env.AI_PROVIDER_PRIMARY;
});

afterAll(() => {
  delete process.env.ANTHROPIC_API_KEY;
});

function request(extra: Record<string, unknown> = {}) {
  return {
    messages: [{ role: "user" as const, content: "what is the invoice total?" }],
    max_tokens: 50,
    model_tier: "cheap" as const,
    metadata: { feature: "test.verify", user_id: "u1", user_role: "cto" },
    ...extra,
  };
}

describe("router verification — when it must NOT spend", () => {
  it("does not check at all unless the caller asked", async () => {
    /* Every existing call site must be unchanged in cost and behaviour. */
    mockMessagesCreate.mockResolvedValue(reply(""));
    await getAIClient().complete(request());
    expect(mockMessagesCreate).toHaveBeenCalledTimes(1);
    expect(mockTrackEvent.mock.calls.some((c) => c[0] === "ai.answer_verified")).toBe(false);
  });

  it("pays for exactly one call when the cheap model did the job", async () => {
    // THE COST CASE. If this ever fails, the feature costs more than it saves.
    mockMessagesCreate.mockResolvedValue(reply("The invoice total is $4,200."));
    const res = await getAIClient().complete(request({ verify: true }));
    expect(mockMessagesCreate).toHaveBeenCalledTimes(1);
    expect(res.content).toBe("The invoice total is $4,200.");
  });

  it("does not pay to overrule a refusal", async () => {
    /* A model declining is usually the system working. Escalating buys a
       larger model's willingness to do what the first one declined. */
    mockMessagesCreate.mockResolvedValue(reply("I'm sorry, I can't help with that."));
    await getAIClient().complete(request({ verify: true }));
    expect(mockMessagesCreate).toHaveBeenCalledTimes(1);
  });

  it("never escalates past the top tier", async () => {
    mockMessagesCreate.mockResolvedValue(reply(""));
    await getAIClient().complete(request({ verify: true, model_tier: "premium" }));
    expect(mockMessagesCreate).toHaveBeenCalledTimes(1);
  });
});

describe("router verification — when it should", () => {
  it("retries once on a better model when the answer fell short", async () => {
    mockMessagesCreate
      .mockResolvedValueOnce(reply("I'll get back to you with those figures shortly."))
      .mockResolvedValueOnce(reply("The invoice total is $4,200."));
    const res = await getAIClient().complete(request({ verify: true }));
    expect(mockMessagesCreate).toHaveBeenCalledTimes(2);
    expect(res.content).toBe("The invoice total is $4,200.");
    // Escalated UP, not sideways: the second call must use a better model.
    expect(mockMessagesCreate.mock.calls[1][0].model).not.toBe(
      mockMessagesCreate.mock.calls[0][0].model,
    );
  });

  it("retries ONCE, never in a loop, even if the retry is also poor", async () => {
    /* A loop here is an unbounded bill attached to one user action. */
    mockMessagesCreate.mockResolvedValue(reply("I'll get back to you shortly."));
    await getAIClient().complete(request({ verify: true }));
    expect(mockMessagesCreate).toHaveBeenCalledTimes(2);
  });

  it("keeps the first answer when the retry throws", async () => {
    // A verified answer beats the first one; the first one beats an error.
    mockMessagesCreate
      .mockResolvedValueOnce(reply("I'll get back to you shortly."))
      .mockRejectedValueOnce(new Error("provider down"));
    const res = await getAIClient().complete(request({ verify: true }));
    expect(res.content).toBe("I'll get back to you shortly.");
  });
});

describe("router verification — what it records", () => {
  it("records the pass, not only the failures", async () => {
    /* "The cheap model was fine" is the finding that justifies routing cheap
       at all, and it is invisible if only failures are counted. */
    mockMessagesCreate.mockResolvedValue(reply("The invoice total is $4,200."));
    await getAIClient().complete(request({ verify: true }));
    const ev = mockTrackEvent.mock.calls.find((c) => c[0] === "ai.answer_verified");
    expect(ev?.[3]).toMatchObject({ sufficient: true, escalated: false, flags: "" });
  });

  it("records which rule fired, so the reason is countable", async () => {
    mockMessagesCreate.mockResolvedValue(reply("Dear [INSERT NAME], thanks."));
    await getAIClient().complete(request({ verify: true }));
    const ev = mockTrackEvent.mock.calls.find((c) => c[0] === "ai.answer_verified");
    expect(ev?.[3]).toMatchObject({ sufficient: false, escalated: true });
    expect(String(ev?.[3].flags)).toContain("placeholder");
  });

  it("marks the escalated call so its spend is separable from the first", async () => {
    /* Without this the second call looks like ordinary traffic and the true
       cost of verification cannot be measured. */
    mockMessagesCreate
      .mockResolvedValueOnce(reply("I'll get back to you shortly."))
      .mockResolvedValueOnce(reply("The invoice total is $4,200."));
    await getAIClient().complete(request({ verify: true }));
    const completions = mockTrackEvent.mock.calls.filter((c) => c[0] === "ai.completion");
    expect(completions.some((c) => String(c[3].feature).endsWith(".escalated"))).toBe(true);
  });
});


/**
 * The judge at the chokepoint.
 *
 * The expensive mistake here is not a missed bad answer, it is the judge
 * running when nobody asked for it. It is a second call on EVERY verified
 * request, whether or not it finds anything, so most of these assert it stayed
 * quiet.
 */
describe("router verification — the model judge", () => {
  /* AN INDEPENDENT FAMILY HAS TO EXIST FOR ANY OF THIS TO HAPPEN.
     Anthropic answers and Azure judges: azure-gpt-4o is the openai lineage, so
     it is a genuine outside check on a Claude answer. Without this the whole
     block would assert on a judge that correctly refuses to run, which is what
     it did the first time this suite met the independence rule. */
  const originalFetch = global.fetch;
  beforeEach(() => {
    process.env.AZURE_OPENAI_ENDPOINT = "https://example.openai.azure.com";
    process.env.AZURE_OPENAI_API_KEY = "azure-key";
    process.env.AZURE_OPENAI_DEPLOYMENT_CHEAP = "gpt-4o-mini";
    process.env.AZURE_OPENAI_DEPLOYMENT_STANDARD = "gpt-4o";
    // Anthropic must stay the AUTHOR, or there is nothing for Azure to check.
    process.env.AI_PROVIDER_PRIMARY = "anthropic";
    _resetAIClientForTests(null);
  });
  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.AZURE_OPENAI_ENDPOINT;
    delete process.env.AZURE_OPENAI_API_KEY;
    delete process.env.AZURE_OPENAI_DEPLOYMENT_CHEAP;
    delete process.env.AZURE_OPENAI_DEPLOYMENT_STANDARD;
    delete process.env.AI_PROVIDER_PRIMARY;
  });

  /** The judge's reply, served by Azure rather than by the answering family. */
  function judgeReplies(text: string) {
    const f = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({
        choices: [{ message: { role: "assistant", content: text } }],
        usage: { prompt_tokens: 20, completion_tokens: 8 },
        model: "gpt-4o",
      }),
      text: async () => "",
    });
    global.fetch = f as unknown as typeof fetch;
    return f;
  }

  it("does not run for verify: true, only for deep", async () => {
    /* Two settings, not one. The free rules must never quietly buy a call. */
    mockMessagesCreate.mockResolvedValue(reply("The invoice total is $4,200."));
    await getAIClient().complete(request({ verify: true }));
    expect(mockMessagesCreate).toHaveBeenCalledTimes(1);
    expect(mockTrackEvent.mock.calls.some((c) => c[0] === "ai.answer_judged")).toBe(false);
  });

  it("does not run when the free rules already failed the answer", async () => {
    /* An answer known to be truncated does not need a model's opinion on
       whether it is sound: that is a call bought for no new information. */
    mockMessagesCreate
      .mockResolvedValueOnce(reply("I'll get back to you shortly."))
      .mockResolvedValueOnce(reply("The invoice total is $4,200."));
    await getAIClient().complete(request({ verify: "deep" }));
    expect(mockTrackEvent.mock.calls.some((c) => c[0] === "ai.answer_judged")).toBe(false);
    // One original call plus one escalation. No judge call in between.
    expect(mockMessagesCreate).toHaveBeenCalledTimes(2);
  });

  it("judges a rule-clean answer, and ships it when the judge agrees", async () => {
    mockMessagesCreate.mockResolvedValue(reply("The invoice total is $4,200."));
    const judge = judgeReplies("VERDICT: sound REASON: answers directly");
    const res = await getAIClient().complete(request({ verify: "deep" }));
    expect(res.content).toBe("The invoice total is $4,200.");
    // One answer from Anthropic, one verdict from Azure, no escalation.
    expect(mockMessagesCreate).toHaveBeenCalledTimes(1);
    expect(judge).toHaveBeenCalledTimes(1);
    const ev = mockTrackEvent.mock.calls.find((c) => c[0] === "ai.answer_judged");
    expect(ev?.[3]).toMatchObject({ sound: true, verdict: "sound", judged: true });
  });

  it("escalates when the judge finds a problem a rule could not see", async () => {
    /* THE POINT OF THE STAGE: a confident answer that reads perfectly and is
       wrong passes every rule. */
    mockMessagesCreate
      .mockResolvedValueOnce(reply("The invoice total is $4,200."))
      .mockResolvedValueOnce(reply("The invoice total is $3,100, per invoice 88."));
    judgeReplies("VERDICT: unsupported REASON: no source for that figure");
    const res = await getAIClient().complete(request({ verify: "deep" }));
    expect(res.content).toBe("The invoice total is $3,100, per invoice 88.");
    expect(mockMessagesCreate).toHaveBeenCalledTimes(2);
  });

  it("ships the answer when the judge cannot be read, and says it was unjudged", async () => {
    // A judge that breaks answers is worse than no judge.
    mockMessagesCreate.mockResolvedValue(reply("The invoice total is $4,200."));
    judgeReplies("hmm, seems fine to me");
    const res = await getAIClient().complete(request({ verify: "deep" }));
    expect(res.content).toBe("The invoice total is $4,200.");
    const ev = mockTrackEvent.mock.calls.find((c) => c[0] === "ai.answer_judged");
    expect(ev?.[3]).toMatchObject({ sound: true, judged: false });
  });

  it("ships the answer when the judge call throws", async () => {
    mockMessagesCreate.mockResolvedValue(reply("The invoice total is $4,200."));
    global.fetch = jest.fn().mockRejectedValue(new Error("provider down")) as unknown as typeof fetch;
    const res = await getAIClient().complete(request({ verify: "deep" }));
    expect(res.content).toBe("The invoice total is $4,200.");
  });

  it("marks the judge's own spend so it is separable from the answer's", async () => {
    /* Without this the judge looks like ordinary traffic and the true cost of
       deep verification cannot be measured against what it saves. */
    mockMessagesCreate.mockResolvedValue(reply("The invoice total is $4,200."));
    judgeReplies("VERDICT: sound REASON: fine");
    await getAIClient().complete(request({ verify: "deep" }));
    const completions = mockTrackEvent.mock.calls.filter((c) => c[0] === "ai.completion");
    expect(completions.some((c) => String(c[3].feature).endsWith(".judge"))).toBe(true);
  });

  it("judges with a DIFFERENT FAMILY, not merely a different model", async () => {
    /* A bigger sibling is still a sibling. What makes a check worth its cost
       is that it does not share the blind spots of the thing it is checking. */
    mockMessagesCreate.mockResolvedValue(reply("The invoice total is $4,200."));
    judgeReplies("VERDICT: sound REASON: fine");
    await getAIClient().complete(request({ verify: "deep" }));
    const ev = mockTrackEvent.mock.calls.find((c) => c[0] === "ai.answer_judged");
    expect(ev?.[3]).toMatchObject({
      independence: "independent",
      author_lineage: "anthropic",
      judge_lineage: "openai",
      judged: true,
    });
  });

  it("does not judge a judge", async () => {
    // A judge judged by a judge is a bill with no upper bound.
    mockMessagesCreate.mockResolvedValue(reply("The invoice total is $4,200."));
    judgeReplies("VERDICT: sound REASON: fine");
    await getAIClient().complete(request({ verify: "deep" }));
    const judged = mockTrackEvent.mock.calls.filter((c) => c[0] === "ai.answer_judged");
    expect(judged).toHaveLength(1);
  });
});


/**
 * The judge must come from a different family.
 *
 * The failure being guarded is silent agreement: a sibling checking its own
 * family's work, passing it, and leaving a row that says "checked". On an
 * estate served by one vendor that is what the previous version did on every
 * call, so the assertions here are mostly that NO judging happened.
 */
describe("router verification — independence of the judge", () => {
  it("does not judge at all when every model shares the answering family", async () => {
    /* Anthropic only, which is this test file's environment. A Claude answer
       has no independent checker here, and a sibling check recorded as a check
       is worse than an honest gap. */
    mockMessagesCreate.mockResolvedValue(reply("The invoice total is $4,200."));
    const res = await getAIClient().complete(request({ verify: "deep" }));

    expect(res.content).toBe("The invoice total is $4,200.");
    // One call: the answer. No second call was bought to hear itself agree.
    expect(mockMessagesCreate).toHaveBeenCalledTimes(1);

    const ev = mockTrackEvent.mock.calls.find((c) => c[0] === "ai.answer_judged");
    expect(ev?.[3]).toMatchObject({
      judged: false,
      independence: "no_independent_lineage_configured",
      author_lineage: "anthropic",
      judge_lineage: "none",
    });
  });

  it("still ships the answer when no independent judge exists", async () => {
    // An absent checker must never cost the reader their answer.
    mockMessagesCreate.mockResolvedValue(reply("The invoice total is $4,200."));
    const res = await getAIClient().complete(request({ verify: "deep" }));
    expect(res.content).toBe("The invoice total is $4,200.");
  });

  it("does not escalate on the strength of a check that never happened", async () => {
    /* unjudged() reports sound:true precisely so an absent judge cannot
       trigger a paid retry. */
    mockMessagesCreate.mockResolvedValue(reply("The invoice total is $4,200."));
    await getAIClient().complete(request({ verify: "deep" }));
    const verified = mockTrackEvent.mock.calls.find((c) => c[0] === "ai.answer_verified");
    expect(verified?.[3]).toMatchObject({ escalated: false });
  });

  it("records both families, so the claim can be checked rather than believed", async () => {
    mockMessagesCreate.mockResolvedValue(reply("The invoice total is $4,200."));
    await getAIClient().complete(request({ verify: "deep" }));
    const ev = mockTrackEvent.mock.calls.find((c) => c[0] === "ai.answer_judged");
    // "Checked" says nothing. Naming both sides is what an auditor can test.
    expect(ev?.[3]).toHaveProperty("author_lineage");
    expect(ev?.[3]).toHaveProperty("judge_lineage");
  });
});
