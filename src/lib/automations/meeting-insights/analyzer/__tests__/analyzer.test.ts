/**
 * Tests for the meeting-insights analyzer.
 *
 * The Anthropic SDK is mocked at the wrapper boundary (callAnthropic).
 * No real LLM calls; fixture responses cover success, partial, and
 * error paths.
 */

const mockCallAnthropic = jest.fn();
jest.mock("../anthropic", () => ({
  callAnthropic: (...a: unknown[]) => mockCallAnthropic(...a),
  isAnalyzerAvailable: () => true,
}));

import {
  analyzeMessage,
  buildUserPrompt,
  safeParseAnalysis,
  SYSTEM_PROMPT,
} from "../index";

beforeEach(() => {
  jest.clearAllMocks();
});

describe("buildUserPrompt", () => {
  it("composes subject/from/date/body in the expected layout", () => {
    const out = buildUserPrompt({
      subject: "Weekly sync",
      from_address: "alicia@x",
      from_name: "Alicia",
      received_at: "2026-04-01T12:00:00Z",
      body_text: "Decided to ship pricing v2 next sprint.",
      attachments: [],
    });
    expect(out).toContain("Subject: Weekly sync");
    expect(out).toContain("From: Alicia <alicia@x>");
    expect(out).toContain("Date: 2026-04-01T12:00:00Z");
    expect(out).toContain("[BODY]");
    expect(out).toContain("Decided to ship pricing v2");
  });

  it("includes attachments only when extracted_text is present", () => {
    const out = buildUserPrompt({
      subject: "s",
      from_address: "a@x",
      from_name: null,
      received_at: "2026-04-01T00:00:00Z",
      body_text: "body",
      attachments: [
        { filename: "x.docx", extracted_text: "Hello world" },
        { filename: "y.bin", extracted_text: null },
      ],
    });
    expect(out).toContain("[ATTACHMENTS]");
    expect(out).toContain("--- ATTACHMENT: x.docx ---");
    expect(out).toContain("Hello world");
    expect(out).not.toContain("y.bin");
  });

  it("truncates very long bodies", () => {
    const long = "x".repeat(120_000);
    const out = buildUserPrompt({
      subject: "s",
      from_address: "a@x",
      from_name: null,
      received_at: "2026-04-01T00:00:00Z",
      body_text: long,
      attachments: [],
    });
    expect(out.length).toBeLessThan(70_000);
    expect(out).toContain("(truncated)");
  });
});

describe("safeParseAnalysis", () => {
  it("parses a clean JSON response", () => {
    const text = JSON.stringify({
      decisions: [{ summary: "Ship v2" }],
      action_items: [
        { description: "Update pricing page", owner: "alice", completed: false },
      ],
      topics: ["Pricing", "Q3 launch", ""],
      attendees: [{ name: "Alice", email: "alice@x" }],
      blockers: [{ description: "Need legal sign-off", severity: "high" }],
      next_steps: [{ description: "Schedule review", when: "next week" }],
    });
    const out = safeParseAnalysis(text);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.analysis.decisions).toHaveLength(1);
    expect(out.analysis.action_items[0].owner).toBe("alice");
    expect(out.analysis.action_items[0].completed).toBe(false);
    // topics get lowercased + trimmed; empty string filtered.
    expect(out.analysis.topics).toEqual(["pricing", "q3 launch"]);
    expect(out.analysis.blockers[0].severity).toBe("high");
  });

  it("strips ```json``` fences", () => {
    const text = "```json\n" + JSON.stringify({
      decisions: [],
      action_items: [],
      topics: ["foo"],
      attendees: [],
      blockers: [],
      next_steps: [],
    }) + "\n```";
    const out = safeParseAnalysis(text);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.analysis.topics).toEqual(["foo"]);
  });

  it("rejects non-JSON gibberish", () => {
    const out = safeParseAnalysis("hello world");
    expect(out.ok).toBe(false);
  });

  it("rejects an array at the top level", () => {
    const out = safeParseAnalysis("[1, 2, 3]");
    expect(out.ok).toBe(false);
  });

  it("drops invalid items but keeps the rest", () => {
    const text = JSON.stringify({
      decisions: [{ summary: "" }, { summary: "Ok" }, "bad"],
      action_items: [{ description: "a" }, { description: "" }],
      topics: ["valid", 123, ""],
      attendees: [{}],
      blockers: [{ description: "b", severity: "extreme" }],
      next_steps: [],
    });
    const out = safeParseAnalysis(text);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.analysis.decisions).toHaveLength(1);
    expect(out.analysis.action_items).toHaveLength(1);
    expect(out.analysis.topics).toEqual(["valid"]);
    expect(out.analysis.attendees).toHaveLength(0);
    expect(out.analysis.blockers[0].severity).toBeUndefined();
  });

  it("salvages a JSON object embedded in trailing prose", () => {
    const text = `Sure, here you go: { "decisions": [], "action_items": [], "topics": ["alpha"], "attendees": [], "blockers": [], "next_steps": [] } — let me know!`;
    const out = safeParseAnalysis(text);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.analysis.topics).toEqual(["alpha"]);
  });
});

describe("analyzeMessage", () => {
  const baseInput = {
    subject: "Weekly",
    from_address: "a@x",
    from_name: null,
    received_at: "2026-04-01T00:00:00Z",
    body_text: "We decided to ship.",
    attachments: [],
  };

  it("returns success when the LLM returns valid JSON", async () => {
    mockCallAnthropic.mockResolvedValueOnce({
      ok: true,
      text: JSON.stringify({
        decisions: [{ summary: "Ship" }],
        action_items: [],
        topics: ["launch"],
        attendees: [],
        blockers: [],
        next_steps: [],
      }),
      model: "claude-haiku-4-5",
      tokens_used: 1234,
    });
    const out = await analyzeMessage(baseInput);
    expect(out.status).toBe("success");
    expect(out.analysis.decisions).toHaveLength(1);
    expect(out.tokens_used).toBe(1234);
  });

  it("returns partial when JSON parsing fails", async () => {
    mockCallAnthropic.mockResolvedValueOnce({
      ok: true,
      text: "not json at all",
      model: "claude-haiku-4-5",
      tokens_used: 100,
    });
    const out = await analyzeMessage(baseInput);
    expect(out.status).toBe("partial");
    expect(out.raw_llm_response).toBe("not json at all");
    expect(out.error_detail).toBeDefined();
  });

  it("returns error when the SDK call fails", async () => {
    mockCallAnthropic.mockResolvedValueOnce({
      ok: false,
      error_detail: "ANTHROPIC_API_KEY not set",
    });
    const out = await analyzeMessage(baseInput);
    expect(out.status).toBe("error");
    expect(out.error_detail).toContain("ANTHROPIC_API_KEY");
  });

  it("uses the cached system prompt with the schema", () => {
    expect(SYSTEM_PROMPT).toContain('"decisions"');
    expect(SYSTEM_PROMPT).toContain('"action_items"');
    expect(SYSTEM_PROMPT).toContain('"topics"');
    expect(SYSTEM_PROMPT).toContain("Return ONLY the JSON object");
  });
});
