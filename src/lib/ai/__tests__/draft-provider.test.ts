 
export {};

const fetchMock = jest.fn();
beforeEach(() => {
  fetchMock.mockReset();
  global.fetch = fetchMock as any;
  process.env.ANTHROPIC_API_KEY = "test-key";
  delete process.env.ANTHROPIC_DRAFT_MODEL;
  // Reset cached provider so each test gets a fresh instance.
  jest.resetModules();
});

describe("AnthropicDraftProvider", () => {
  it("posts the right shape and returns parsed text + token usage", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [{ type: "text", text: "Sounds good — sending now." }],
        usage: { input_tokens: 25, output_tokens: 8 },
        model: "claude-x",
      }),
    });
    const { getDraftProvider, __setDraftProviderForTests } = await import(
      "@/lib/ai/draft-provider"
    );
    __setDraftProviderForTests(null);
    const result = await getDraftProvider().draftReply({
      surface: "chat",
      recipientName: "Max",
      threadContext: [{ from: "Max", text: "any update?" }],
      draftSoFar: "almost done",
      selfName: "Nick",
    });
    expect(result.text).toBe("Sounds good — sending now.");
    expect(result.model).toBe("claude-x");
    expect(result.promptTokens).toBe(25);
    expect(result.completionTokens).toBe(8);
    const call = fetchMock.mock.calls[0];
    expect(call[0]).toBe("https://api.anthropic.com/v1/messages");
    const payload = JSON.parse(call[1].body);
    expect(payload.system).toMatch(/conversational/);
    expect(payload.messages[0].content).toMatch(/Max/);
    expect(payload.messages[0].content).toMatch(/almost done/);
  });

  it("uses email-tone system prompt for surface=email", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [{ type: "text", text: "Best, Nick" }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    });
    const { getDraftProvider, __setDraftProviderForTests } = await import(
      "@/lib/ai/draft-provider"
    );
    __setDraftProviderForTests(null);
    await getDraftProvider().draftReply({
      surface: "email",
      selfName: "Nick",
    });
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(payload.system).toMatch(/email/);
    expect(payload.system).toMatch(/sign-off/);
  });

  it("throws when ANTHROPIC_API_KEY is missing", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const { getDraftProvider, __setDraftProviderForTests } = await import(
      "@/lib/ai/draft-provider"
    );
    __setDraftProviderForTests(null);
    await expect(
      getDraftProvider().draftReply({ surface: "chat" }),
    ).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });

  it("surfaces upstream HTTP errors with status code", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => "rate limited",
    });
    const { getDraftProvider, __setDraftProviderForTests } = await import(
      "@/lib/ai/draft-provider"
    );
    __setDraftProviderForTests(null);
    await expect(
      getDraftProvider().draftReply({ surface: "chat" }),
    ).rejects.toThrow(/429/);
  });
});
