/**
 * Tests for the Anthropic SDK wrapper.
 *
 * The SDK itself is mocked at the module boundary; we verify that the
 * wrapper:
 *   - returns ok=false when ANTHROPIC_API_KEY is missing
 *   - parses text blocks correctly
 *   - maps SDK error classes to friendly error_detail strings
 *   - sends the system prompt with cache_control: ephemeral
 */

const mockCreate = jest.fn();

class MockAuthenticationError extends Error {}
class MockRateLimitError extends Error {}
class MockAPIError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

jest.mock("@anthropic-ai/sdk", () => {
  const ctor = jest.fn().mockImplementation(() => ({
    messages: { create: (...a: unknown[]) => mockCreate(...a) },
  }));
  // The SDK exposes error classes on the default export.
  return Object.assign(ctor, {
    default: ctor,
    AuthenticationError: MockAuthenticationError,
    RateLimitError: MockRateLimitError,
    APIError: MockAPIError,
  });
});

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  jest.clearAllMocks();
  jest.resetModules();
  process.env = { ...ORIGINAL_ENV };
});

afterAll(() => {
  process.env = ORIGINAL_ENV;
});

describe("callAnthropic", () => {
  it("returns error when ANTHROPIC_API_KEY is missing", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const { callAnthropic } = await import("../anthropic");
    const out = await callAnthropic({
      system_prompt: "sys",
      user_prompt: "user",
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error_detail).toContain("ANTHROPIC_API_KEY");
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("returns success and aggregates text blocks", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    mockCreate.mockResolvedValueOnce({
      content: [
        { type: "text", text: "hello " },
        { type: "tool_use" },
        { type: "text", text: "world" },
      ],
      model: "claude-haiku-4-5",
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        cache_read_input_tokens: 5,
        cache_creation_input_tokens: 3,
      },
    });
    const { callAnthropic } = await import("../anthropic");
    const out = await callAnthropic({
      system_prompt: "sys",
      user_prompt: "user",
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.text).toBe("hello world");
    expect(out.tokens_used).toBe(10 + 20 + 5 + 3);
  });

  it("sends cache_control on the system prompt block", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "{}" }],
      model: "claude-haiku-4-5",
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    const { callAnthropic } = await import("../anthropic");
    await callAnthropic({ system_prompt: "stable schema", user_prompt: "u" });
    const args = mockCreate.mock.calls[0][0];
    expect(Array.isArray(args.system)).toBe(true);
    const lastBlock = args.system[args.system.length - 1];
    expect(lastBlock.cache_control).toEqual({ type: "ephemeral" });
    expect(lastBlock.text).toBe("stable schema");
  });

  it("maps RateLimitError to error_detail", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    mockCreate.mockRejectedValueOnce(new MockRateLimitError("slow down"));
    const { callAnthropic } = await import("../anthropic");
    const out = await callAnthropic({ system_prompt: "s", user_prompt: "u" });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error_detail).toContain("rate_limited");
  });

  it("maps APIError with status code", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    mockCreate.mockRejectedValueOnce(new MockAPIError(500, "boom"));
    const { callAnthropic } = await import("../anthropic");
    const out = await callAnthropic({ system_prompt: "s", user_prompt: "u" });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error_detail).toContain("api_error_500");
  });

  it("returns error when no text blocks present", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "tool_use" }],
      model: "claude-haiku-4-5",
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    const { callAnthropic } = await import("../anthropic");
    const out = await callAnthropic({ system_prompt: "s", user_prompt: "u" });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error_detail).toBe("claude returned no text blocks");
  });
});

describe("isAnalyzerAvailable", () => {
  it("returns false without env", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const { isAnalyzerAvailable } = await import("../anthropic");
    expect(isAnalyzerAvailable()).toBe(false);
  });
  it("returns true with env", async () => {
    process.env.ANTHROPIC_API_KEY = "x";
    const { isAnalyzerAvailable } = await import("../anthropic");
    expect(isAnalyzerAvailable()).toBe(true);
  });
});
