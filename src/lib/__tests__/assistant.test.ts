/**
 * Assistant Tests
 *
 * Tests the priority chain: knowledge -> codebase -> analytics -> AI -> fallback.
 * All external dependencies are mocked.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// Mocks — must be defined before imports
// ---------------------------------------------------------------------------

const mockSearchKnowledge = jest.fn();
const mockSaveAnswer = jest.fn();
const mockSearchCodebase = jest.fn();
const mockTrackEvent = jest.fn();
const mockSafeQuery = jest.fn();

jest.mock("@/lib/knowledge", () => ({
  searchKnowledge: (...args: any[]) => mockSearchKnowledge(...args),
  saveAnswer: (...args: any[]) => mockSaveAnswer(...args),
}));

jest.mock("@/lib/codebase-connector", () => ({
  searchCodebase: (...args: any[]) => mockSearchCodebase(...args),
}));

jest.mock("@/lib/analytics", () => ({
  trackEvent: (...args: any[]) => mockTrackEvent(...args),
}));

jest.mock("@/lib/db", () => ({
  query: jest.fn(),
  safeQuery: (...args: any[]) => mockSafeQuery(...args),
}));

jest.mock("@/lib/triple-write", () => ({
  tripleWriteKnowledge: jest.fn().mockResolvedValue(undefined),
  tripleWriteEvent: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("@/lib/neo4j", () => ({
  recordKnowledgeInteraction: jest.fn().mockResolvedValue(undefined),
}));

import { chat, getConversationHistory, rateResponse } from "@/lib/assistant";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();
  // Default: no knowledge, no codebase, no analytics, no AI
  mockSearchKnowledge.mockResolvedValue([]);
  mockSearchCodebase.mockReturnValue([]);
  mockSaveAnswer.mockResolvedValue(null);
  mockSafeQuery.mockResolvedValue({ rows: [], fromCache: true });

  // Clear env
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.WOLFPACK_AUTO_REPO;
});

// ---------------------------------------------------------------------------
// Knowledge cache hit
// ---------------------------------------------------------------------------

describe("knowledge cache hit", () => {
  test("returns source=knowledge_cache with tokensUsed=0", async () => {
    mockSearchKnowledge.mockResolvedValue([
      {
        id: "k-1",
        question: "How does auth work?",
        answer: "JWT-based auth with role hierarchy.",
        source: "docs",
        rating: 5,
        view_count: 10,
        tokens_used: 0,
        tags: ["auth"],
      },
    ]);

    const result = await chat("How does auth work?", "u1", "dev");

    expect(result.source).toBe("knowledge_cache");
    expect(result.tokensUsed).toBe(0);
    expect(result.response).toContain("JWT");
    expect(result.conversationId).toBeTruthy();
  });

  test("tracks system.ai_call_skipped on cache hit", async () => {
    mockSearchKnowledge.mockResolvedValue([
      {
        id: "k-1",
        question: "Test",
        answer: "Answer",
        source: "docs",
        rating: 4,
        view_count: 1,
        tokens_used: 0,
        tags: [],
      },
    ]);

    await chat("Test", "u1", "dev");

    expect(mockTrackEvent).toHaveBeenCalledWith(
      "system.ai_call_skipped",
      "u1",
      "dev",
      expect.objectContaining({ reason: "knowledge_cache_hit" }),
    );
  });
});

// ---------------------------------------------------------------------------
// Codebase search hit
// ---------------------------------------------------------------------------

describe("codebase search hit", () => {
  test("returns source=codebase with tokensUsed=0 for code questions", async () => {
    process.env.WOLFPACK_AUTO_REPO = "/tmp/test-repo";
    mockSearchCodebase.mockReturnValue([
      { file: "src/auth.ts", line: 10, content: "export function verifyToken()" },
    ]);

    const result = await chat("Where is the auth function?", "u1", "dev");

    expect(result.source).toBe("codebase");
    expect(result.tokensUsed).toBe(0);
    expect(result.response).toContain("src/auth.ts");
  });

  test("tracks system.ai_call_skipped on codebase hit", async () => {
    process.env.WOLFPACK_AUTO_REPO = "/tmp/test-repo";
    mockSearchCodebase.mockReturnValue([
      { file: "src/test.ts", line: 1, content: "const x = 1" },
    ]);

    await chat("Where is the test file?", "u1", "dev");

    expect(mockTrackEvent).toHaveBeenCalledWith(
      "system.ai_call_skipped",
      "u1",
      "dev",
      expect.objectContaining({ reason: "codebase_hit" }),
    );
  });
});

// ---------------------------------------------------------------------------
// AI fallback
// ---------------------------------------------------------------------------

describe("AI fallback", () => {
  test("returns source=fallback when no AI key is set", async () => {
    const result = await chat("What is quantum computing?", "u1", "dev");

    expect(result.source).toBe("fallback");
    expect(result.tokensUsed).toBe(0);
  });

  test("returns source=ai when API key is set and AI responds", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";

    // Mock fetch for the AI call
    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [{ text: "Quantum computing uses qubits." }],
        usage: { input_tokens: 100, output_tokens: 50 },
      }),
    });
    global.fetch = mockFetch as any;

    const result = await chat("What is quantum computing?", "u1", "dev");

    expect(result.source).toBe("ai");
    expect(result.tokensUsed).toBe(150);
    expect(result.response).toContain("qubits");

    // Verify it cached the response
    expect(mockSaveAnswer).toHaveBeenCalledWith(
      "What is quantum computing?",
      "Quantum computing uses qubits.",
      "ai",
      "u1",
      undefined,
      undefined,
      150,
    );
  });

  test("tracks system.ai_call_made on AI call", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [{ text: "Answer" }],
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    }) as any;

    await chat("Random question no keywords", "u1", "dev");

    expect(mockTrackEvent).toHaveBeenCalledWith(
      "system.ai_call_made",
      "u1",
      "dev",
      expect.objectContaining({ module: "assistant" }),
    );
  });
});

// ---------------------------------------------------------------------------
// Conversation history
// ---------------------------------------------------------------------------

describe("conversation history", () => {
  test("is maintained across messages", async () => {
    const r1 = await chat("Hello", "u1", "dev");
    const convId = r1.conversationId;

    await chat("Follow up", "u1", "dev", convId);

    const history = getConversationHistory(convId);
    expect(history.length).toBe(4); // 2 user + 2 assistant
    expect(history[0].role).toBe("user");
    expect(history[0].content).toBe("Hello");
    expect(history[1].role).toBe("assistant");
    expect(history[2].role).toBe("user");
    expect(history[2].content).toBe("Follow up");
    expect(history[3].role).toBe("assistant");
  });

  test("getConversationHistory returns messages in order", async () => {
    const r1 = await chat("First", "u1", "dev");
    await chat("Second", "u1", "dev", r1.conversationId);
    await chat("Third", "u1", "dev", r1.conversationId);

    const history = getConversationHistory(r1.conversationId);

    // Each chat produces 2 messages (user + assistant)
    expect(history.length).toBe(6);
    expect(history[0].content).toBe("First");
    expect(history[2].content).toBe("Second");
    expect(history[4].content).toBe("Third");

    // Verify chronological order
    for (let i = 1; i < history.length; i++) {
      expect(new Date(history[i].timestamp).getTime()).toBeGreaterThanOrEqual(
        new Date(history[i - 1].timestamp).getTime(),
      );
    }
  });

  test("new conversation generates new conversationId", async () => {
    const r1 = await chat("Msg 1", "u1", "dev");
    const r2 = await chat("Msg 2", "u1", "dev");

    expect(r1.conversationId).not.toBe(r2.conversationId);
  });

  test("getConversationHistory returns empty for unknown id", () => {
    const history = getConversationHistory("nonexistent");
    expect(history).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Rating
// ---------------------------------------------------------------------------

describe("rateResponse", () => {
  test("tracks knowledge.answer_rated event", async () => {
    const r = await chat("Hello", "u1", "dev");
    const convId = r.conversationId;

    rateResponse(convId, 1, 5, "u1", "dev");

    expect(mockTrackEvent).toHaveBeenCalledWith(
      "knowledge.answer_rated",
      "u1",
      "dev",
      expect.objectContaining({
        conversation_id: convId,
        message_index: 1,
        rating: 5,
      }),
    );
  });

  test("returns false for invalid conversation", () => {
    const ok = rateResponse("bad-id", 0, 5, "u1", "dev");
    expect(ok).toBe(false);
  });

  test("returns false for user message index", async () => {
    const r = await chat("Hello", "u1", "dev");
    const ok = rateResponse(r.conversationId, 0, 5, "u1", "dev");
    expect(ok).toBe(false); // index 0 is user message
  });
});

// ---------------------------------------------------------------------------
// Event tracking
// ---------------------------------------------------------------------------

describe("event tracking", () => {
  test("every message tracks knowledge.question_asked", async () => {
    await chat("Test question", "u1", "cto");

    expect(mockTrackEvent).toHaveBeenCalledWith(
      "knowledge.question_asked",
      "u1",
      "cto",
      expect.objectContaining({
        question_length: 13,
        module: "assistant",
      }),
    );
  });

  test("cache hit tracks system.ai_call_skipped", async () => {
    mockSearchKnowledge.mockResolvedValue([
      {
        id: "k-1",
        question: "Test",
        answer: "Cached answer",
        source: "docs",
        rating: 5,
        view_count: 1,
        tokens_used: 0,
        tags: [],
      },
    ]);

    await chat("Test", "u1", "dev");

    const skippedCalls = mockTrackEvent.mock.calls.filter(
      (c: any[]) => c[0] === "system.ai_call_skipped",
    );
    expect(skippedCalls.length).toBeGreaterThan(0);
  });
});
