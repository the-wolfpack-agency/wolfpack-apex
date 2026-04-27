/**
 * support/categorizer — unit tests.
 *
 * Mocks @/lib/ai's getAIClient so we drive every classification path
 * without hitting Anthropic. Verifies:
 *   - each non-general category returns from a known input
 *   - low-confidence is coerced to 'general'
 *   - AI throws → fallback 'general' with confidence 0
 *   - JSON parse failure → fallback 'general'
 *   - unknown category returned by the model → fallback 'general'
 *   - the request shape includes feature='support.categorize',
 *     model_tier='cheap', sensitivity='public', system prompt set
 */

const mockComplete = jest.fn();
jest.mock("@/lib/ai", () => ({
  getAIClient: () => ({ complete: mockComplete }),
}));

import { categorizeTicket } from "@/lib/support/categorizer";

function aiOk(content: string) {
  return {
    content,
    model_used: "claude-haiku-4-5",
    provider_used: "anthropic",
    input_tokens: 50,
    output_tokens: 12,
    cost_usd: 0.0001,
    latency_ms: 80,
  };
}

let consoleWarnSpy: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  consoleWarnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  consoleWarnSpy.mockRestore();
});

describe("categorizeTicket — happy paths per category", () => {
  it("returns m365 for an Outlook AADSTS error", async () => {
    mockComplete.mockResolvedValueOnce(
      aiOk(
        `{"category":"m365","confidence":0.92,"reasoning":"AADSTS error during Outlook sign-in"}`,
      ),
    );
    const out = await categorizeTicket({
      title: "Cannot sign in to Outlook",
      body: "I keep getting AADSTS50126 every time I try to sign in.",
    });
    expect(out.category).toBe("m365");
    expect(out.confidence).toBeCloseTo(0.92, 5);
    expect(out.reasoning).toMatch(/AADSTS/);
  });

  it("returns azure for an Azure App Service question", async () => {
    mockComplete.mockResolvedValueOnce(
      aiOk(
        `{"category":"azure","confidence":0.88,"reasoning":"App Service deployment slot question"}`,
      ),
    );
    const out = await categorizeTicket({
      title: "Azure App Service deployment slot",
      body: "How do I swap deployment slots in our Azure App Service?",
    });
    expect(out.category).toBe("azure");
    expect(out.confidence).toBeCloseTo(0.88, 5);
  });

  it("returns instinct for a question about the Instinct dashboard", async () => {
    mockComplete.mockResolvedValueOnce(
      aiOk(
        `{"category":"instinct","confidence":0.81,"reasoning":"Instinct dashboard not loading widgets"}`,
      ),
    );
    const out = await categorizeTicket({
      title: "Instinct dashboard widgets blank",
      body: "After login the dashboard widgets render empty in Instinct.",
    });
    expect(out.category).toBe("instinct");
  });

  it("returns wolfpack-auto for a dealer onboarding question", async () => {
    mockComplete.mockResolvedValueOnce(
      aiOk(
        `{"category":"wolfpack-auto","confidence":0.9,"reasoning":"dealer onboarding inventory sync"}`,
      ),
    );
    const out = await categorizeTicket({
      title: "Dealer inventory not syncing",
      body: "Our dealer onboarding finished but inventory is empty in Wolfpack Auto.",
    });
    expect(out.category).toBe("wolfpack-auto");
  });

  it("returns porsche-classes for an academy class registration question", async () => {
    mockComplete.mockResolvedValueOnce(
      aiOk(
        `{"category":"porsche-classes","confidence":0.85,"reasoning":"Porsche academy registration"}`,
      ),
    );
    const out = await categorizeTicket({
      title: "Porsche academy class registration",
      body: "How do I register for the next Porsche academy class?",
    });
    expect(out.category).toBe("porsche-classes");
  });

  it("returns billing for a license cost question", async () => {
    mockComplete.mockResolvedValueOnce(
      aiOk(
        `{"category":"billing","confidence":0.82,"reasoning":"M365 license cost question"}`,
      ),
    );
    const out = await categorizeTicket({
      title: "Cost of additional licenses",
      body: "What is the monthly cost of adding three more licenses to our subscription?",
    });
    expect(out.category).toBe("billing");
  });

  it("returns urgent for a suspected breach overriding category", async () => {
    mockComplete.mockResolvedValueOnce(
      aiOk(
        `{"category":"urgent","confidence":0.97,"reasoning":"active account takeover reported"}`,
      ),
    );
    const out = await categorizeTicket({
      title: "Suspected account takeover",
      body: "Our CEO says he is locked out RIGHT NOW and his email is sending spam to clients.",
    });
    expect(out.category).toBe("urgent");
  });
});

describe("categorizeTicket — fallback paths", () => {
  it("coerces low-confidence picks to 'general'", async () => {
    mockComplete.mockResolvedValueOnce(
      aiOk(
        `{"category":"m365","confidence":0.3,"reasoning":"vague Outlook mention"}`,
      ),
    );
    const out = await categorizeTicket({
      title: "Hi",
      body: "Could you help, something with Outlook maybe?",
    });
    expect(out.category).toBe("general");
    expect(out.confidence).toBeCloseTo(0.3, 5);
  });

  it("falls back to 'general' with confidence 0 when AI throws", async () => {
    mockComplete.mockRejectedValueOnce(new Error("anthropic 500"));
    const out = await categorizeTicket({
      title: "anything",
      body: "anything",
    });
    expect(out.category).toBe("general");
    expect(out.confidence).toBe(0);
    expect(consoleWarnSpy).toHaveBeenCalled();
  });

  it("falls back to 'general' when the response is not valid JSON", async () => {
    mockComplete.mockResolvedValueOnce(aiOk("not json at all"));
    const out = await categorizeTicket({
      title: "x",
      body: "y",
    });
    expect(out.category).toBe("general");
    expect(out.confidence).toBe(0);
  });

  it("falls back to 'general' when the model returns an unknown category", async () => {
    mockComplete.mockResolvedValueOnce(
      aiOk(`{"category":"weather","confidence":0.95,"reasoning":"sunshine"}`),
    );
    const out = await categorizeTicket({
      title: "x",
      body: "y",
    });
    expect(out.category).toBe("general");
    expect(out.confidence).toBe(0);
  });

  it("strips a markdown fence around the JSON before parsing", async () => {
    mockComplete.mockResolvedValueOnce(
      aiOk(
        '```json\n{"category":"billing","confidence":0.78,"reasoning":"invoice"}\n```',
      ),
    );
    const out = await categorizeTicket({
      title: "Invoice question",
      body: "Can you resend last month's invoice?",
    });
    expect(out.category).toBe("billing");
    expect(out.confidence).toBeCloseTo(0.78, 5);
  });
});

describe("categorizeTicket — request shape", () => {
  it("calls the AI client with feature='support.categorize', tier='cheap', sensitivity='public', and a system prompt", async () => {
    mockComplete.mockResolvedValueOnce(
      aiOk(`{"category":"general","confidence":0.7,"reasoning":"x"}`),
    );
    await categorizeTicket({
      title: "subj",
      body: "body text",
      diagnostic_text: "diag",
    });
    expect(mockComplete).toHaveBeenCalledTimes(1);
    const req = mockComplete.mock.calls[0][0];
    expect(req.metadata).toMatchObject({ feature: "support.categorize" });
    expect(req.model_tier).toBe("cheap");
    expect(req.sensitivity).toBe("public");
    expect(typeof req.system).toBe("string");
    expect(req.system).toMatch(/classifier/i);
    /* User message includes title, body, and diagnostic when present. */
    const userMsg = req.messages[0].content as string;
    expect(userMsg).toMatch(/subj/);
    expect(userMsg).toMatch(/body text/);
    expect(userMsg).toMatch(/diag/);
  });
});
