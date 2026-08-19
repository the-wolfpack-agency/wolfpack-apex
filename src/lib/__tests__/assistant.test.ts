/**
 * Assistant Tests -- Persistent memory, priority chain, analytics.
 *
 * Tests cover:
 *   - Priority chain: knowledge -> analytics -> AI -> fallback
 *   - Persistent conversations (DB-backed, not in-memory)
 *   - User memory storage and retrieval
 *   - Topic auto-detection
 *   - Conversation summary generation
 *   - Rating, archiving, listing
 *   - Analytics events
 */

 

// ---------------------------------------------------------------------------
// Mocks -- must be defined before imports
// ---------------------------------------------------------------------------

const mockSearchKnowledge = jest.fn();
const mockSaveAnswer = jest.fn();

const mockTrackEvent = jest.fn();
const mockSafeQuery = jest.fn();

jest.mock("@/lib/knowledge", () => ({
  searchKnowledge: (...args: any[]) => mockSearchKnowledge(...args),
  saveAnswer: (...args: any[]) => mockSaveAnswer(...args),
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

const mockGetRelevantContext = jest.fn();
jest.mock("@/lib/assistant/context-resolver", () => ({
  getRelevantContext: (...args: any[]) => mockGetRelevantContext(...args),
}));

/* AI router mock — `callAI` calls getAIClient().complete() instead of
   talking to api.anthropic.com directly, so tests substitute a fake
   client and assert what was passed to `complete`. The default mock
   returns a generic AI response; tests exercising the "no provider"
   case override `mockAIComplete` to throw NoProviderAvailableError. */
const mockAIComplete = jest.fn();
class TestNoProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoProviderAvailableError";
  }
}
jest.mock("@/lib/ai", () => ({
  getAIClient: () => ({ complete: (...args: any[]) => mockAIComplete(...args) }),
  NoProviderAvailableError: TestNoProviderError,
}));

import {
  chat,
  getConversations,
  getConversationMessages,
  rateMessage,
  archiveConversation,
  getUserMemory,
  setUserMemory,
  autoDetectTopics,
  generateConversationSummary,
  getConversationHistory,
  shouldBypassKnowledgeCache,
  type AssistantMessage,
} from "@/lib/assistant";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Track what SQL queries were made, return controlled responses. */
let queryLog: { text: string; params: unknown[] }[] = [];
let queryResponses: Map<string, { rows: any[]; fromCache: boolean }>;

function setupQueryMock() {
  queryLog = [];
  queryResponses = new Map();

  mockSafeQuery.mockImplementation((text: string, params?: unknown[]) => {
    queryLog.push({ text, params: params || [] });

    // Check for specific response overrides
    for (const [pattern, response] of queryResponses.entries()) {
      if (text.includes(pattern)) return Promise.resolve(response);
    }

    // Default: empty result, not from cache
    return Promise.resolve({ rows: [], fromCache: false });
  });
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();
  mockSearchKnowledge.mockResolvedValue([]);

  mockSaveAnswer.mockResolvedValue(null);
  setupQueryMock();

  /* Default: empty grounding bundle so existing tests stay untouched.
     Individual tests override as needed to exercise grounding paths. */
  mockGetRelevantContext.mockResolvedValue({
    question: "",
    surface: "assistant_support",
    sharepoint_hits: [],
    project_tasks: [],
    meeting_notes: [],
    rendered_prompt_block: "",
    total_chars: 0,
    took_ms: 1,
  });

  /* Default AI client mock — tests that exercise the "no provider"
     fallback override this to throw, and tests that exercise an actual
     AI completion override the resolved value as needed. */
  mockAIComplete.mockReset();
  mockAIComplete.mockRejectedValue(new TestNoProviderError("no providers configured"));

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
// AI fallback
// ---------------------------------------------------------------------------

describe("AI fallback", () => {
  test("returns source=fallback when no AI key is set", async () => {
    const result = await chat("What is quantum computing?", "u1", "dev");

    expect(result.source).toBe("fallback");
    expect(result.tokensUsed).toBe(0);
  });

  test("returns source=ai when API key is set and AI responds", async () => {
    mockAIComplete.mockResolvedValueOnce({
      content: "Quantum computing uses qubits.",
      model_used: "test-model",
      provider_used: "test-provider",
      input_tokens: 100,
      output_tokens: 50,
      cost_usd: 0,
      latency_ms: 1,
    });

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
    mockAIComplete.mockResolvedValueOnce({
      content: "Answer",
      model_used: "test-model",
      provider_used: "test-provider",
      input_tokens: 10,
      output_tokens: 5,
      cost_usd: 0,
      latency_ms: 1,
    });

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
// Persistent conversations
// ---------------------------------------------------------------------------

describe("persistent conversations", () => {
  test("creates a new conversation on first message", async () => {
    const result = await chat("Hello", "u1", "dev");

    expect(result.conversationId).toBeTruthy();

    // Should have inserted into instinct_conversations
    const createCalls = queryLog.filter((q) => q.text.includes("INSERT INTO instinct_conversations"));
    expect(createCalls.length).toBe(1);
    expect(createCalls[0].params).toContain("u1");
  });

  test("saves messages to instinct_messages", async () => {
    await chat("Hello world", "u1", "dev");

    // Should have 2 inserts: user message + assistant response
    const msgInserts = queryLog.filter((q) => q.text.includes("INSERT INTO instinct_messages"));
    expect(msgInserts.length).toBe(2);

    // First insert is user message
    expect(msgInserts[0].params).toContain("user");
    expect(msgInserts[0].params).toContain("Hello world");

    // Second insert is assistant response
    expect(msgInserts[1].params).toContain("assistant");
  });

  test("reuses existing conversation when conversationId is provided", async () => {
    const r1 = await chat("First message", "u1", "dev");
    const convId = r1.conversationId;

    queryLog = []; // Clear log
    await chat("Second message", "u1", "dev", convId);

    // Should NOT create a new conversation
    const createCalls = queryLog.filter((q) => q.text.includes("INSERT INTO instinct_conversations"));
    expect(createCalls.length).toBe(0);
  });

  /* 2026-05-23: server-side auto-resume of the most-recent active
   * conversation was removed because it caused the chat UI to jump
   * to an unrelated old conversation when a user sent a fresh message
   * from a new chat (the server silently attached the new message to
   * the user's most-recent existing conversation). The two tests
   * below now verify the new contract: no conversationId always =>
   * a brand-new conversation, regardless of how recent the user's
   * last chat was. */
  test("creates a NEW conversation when no conversationId is provided, even if a recent one exists", async () => {
    const recentConv = {
      id: "existing-conv-123",
      last_message_at: new Date().toISOString(), // Fresh
    };

    queryResponses.set("SELECT id, last_message_at FROM instinct_conversations", {
      rows: [recentConv],
      fromCache: false,
    });

    const result = await chat("Hello", "u1", "dev");

    // Server must NOT auto-attach to the recent conversation. A new
    // chat means a new conversation, period.
    expect(result.conversationId).not.toBe("existing-conv-123");
  });

  test("creates a new conversation when the last message is stale (still true under the new contract)", async () => {
    const staleConv = {
      id: "stale-conv-123",
      last_message_at: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
    };

    queryResponses.set("SELECT id, last_message_at FROM instinct_conversations", {
      rows: [staleConv],
      fromCache: false,
    });

    const result = await chat("Hello", "u1", "dev");

    expect(result.conversationId).not.toBe("stale-conv-123");
  });

  test("updates conversation stats after each message", async () => {
    await chat("Test message", "u1", "dev");

    const updateCalls = queryLog.filter((q) => q.text.includes("UPDATE instinct_conversations"));
    // At least 2 updates: one for user message, one for assistant response
    expect(updateCalls.length).toBeGreaterThanOrEqual(2);
  });

  test("auto-generates conversation title from first message", async () => {
    await chat("How do I configure the payment gateway?", "u1", "dev");

    const titleCalls = queryLog.filter((q) =>
      q.text.includes("UPDATE instinct_conversations SET title"),
    );
    expect(titleCalls.length).toBe(1);
    expect(titleCalls[0].params[1]).toContain("payment gateway");
  });

  test("truncates long first messages for title", async () => {
    const longMsg = "a".repeat(100);
    await chat(longMsg, "u1", "dev");

    const titleCalls = queryLog.filter((q) =>
      q.text.includes("UPDATE instinct_conversations SET title"),
    );
    expect(titleCalls.length).toBe(1);
    const title = titleCalls[0].params[1] as string;
    expect(title.length).toBeLessThanOrEqual(60);
    expect(title).toContain("...");
  });

  test("returns messageId from DB save", async () => {
    const result = await chat("Hello", "u1", "dev");

    expect(result.messageId).toBeTruthy();
    expect(typeof result.messageId).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// getConversations
// ---------------------------------------------------------------------------

describe("getConversations", () => {
  test("returns conversations for a specific user", async () => {
    queryResponses.set("SELECT id, title, status", {
      rows: [
        {
          id: "conv-1",
          title: "Test conversation",
          status: "active",
          message_count: 5,
          total_tokens: 100,
          last_message_at: "2026-04-04T12:00:00Z",
          created_at: "2026-04-04T11:00:00Z",
        },
      ],
      fromCache: false,
    });

    const convs = await getConversations("u1");

    expect(convs).toHaveLength(1);
    expect(convs[0].id).toBe("conv-1");
    expect(convs[0].title).toBe("Test conversation");
    expect(convs[0].messageCount).toBe(5);
    expect(convs[0].totalTokens).toBe(100);
  });

  test("returns only the requesting user's conversations", async () => {
    await getConversations("u1");

    const selectCalls = queryLog.filter((q) =>
      q.text.includes("FROM instinct_conversations") && q.text.includes("WHERE user_id"),
    );
    expect(selectCalls.length).toBe(1);
    expect(selectCalls[0].params).toContain("u1");
  });
});

// ---------------------------------------------------------------------------
// getConversationMessages
// ---------------------------------------------------------------------------

describe("getConversationMessages", () => {
  test("verifies ownership before returning messages", async () => {
    // Ownership check returns empty -- not the user's conversation
    queryResponses.set("SELECT id FROM instinct_conversations WHERE id", {
      rows: [],
      fromCache: false,
    });

    const messages = await getConversationMessages("conv-1", "u1");
    expect(messages).toEqual([]);
  });

  test("returns messages when ownership is verified", async () => {
    // Use a call counter to return different results for each query
    let callCount = 0;
    mockSafeQuery.mockImplementation((text: string, params?: unknown[]) => {
      queryLog.push({ text, params: params || [] });
      callCount++;

      // First call: ownership check
      if (text.includes("SELECT id FROM instinct_conversations WHERE id")) {
        return Promise.resolve({ rows: [{ id: "conv-1" }], fromCache: false });
      }

      // Second call: load messages (returned in DESC order, code reverses)
      if (text.includes("SELECT id, role, content, source")) {
        return Promise.resolve({
          rows: [
            {
              id: "msg-2",
              role: "assistant",
              content: "Hi there!",
              source: "fallback",
              tokens_used: 0,
              rating: null,
              metadata: {},
              created_at: "2026-04-04T12:00:01Z",
            },
            {
              id: "msg-1",
              role: "user",
              content: "Hello",
              source: null,
              tokens_used: 0,
              rating: null,
              metadata: {},
              created_at: "2026-04-04T12:00:00Z",
            },
          ],
          fromCache: false,
        });
      }

      return Promise.resolve({ rows: [], fromCache: false });
    });

    const messages = await getConversationMessages("conv-1", "u1");
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("user");
    expect(messages[1].role).toBe("assistant");
  });
});

// ---------------------------------------------------------------------------
// rateMessage
// ---------------------------------------------------------------------------

describe("rateMessage", () => {
  test("updates rating in DB and tracks event", async () => {
    queryResponses.set("UPDATE instinct_messages SET rating", {
      rows: [{ id: "msg-1", source: "knowledge_cache" }],
      fromCache: false,
    });

    const ok = await rateMessage("msg-1", 5, "u1", "dev");

    expect(ok).toBe(true);
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "knowledge.answer_rated",
      "u1",
      "dev",
      expect.objectContaining({
        message_id: "msg-1",
        rating: 5,
        source: "knowledge_cache",
      }),
    );
  });

  test("returns false for invalid rating", async () => {
    const ok = await rateMessage("msg-1", 0, "u1");
    expect(ok).toBe(false);
  });

  test("returns false when message not found", async () => {
    const ok = await rateMessage("nonexistent", 5, "u1");
    expect(ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// archiveConversation
// ---------------------------------------------------------------------------

describe("archiveConversation", () => {
  test("sets status to archived with summary", async () => {
    // getConversationMessages needs ownership check + messages
    queryResponses.set("SELECT id FROM instinct_conversations WHERE id", {
      rows: [{ id: "conv-1" }],
      fromCache: false,
    });

    queryResponses.set("SELECT id, role, content, source", {
      rows: [
        {
          id: "msg-1",
          role: "user",
          content: "How does auth work?",
          source: null,
          tokens_used: 0,
          rating: null,
          metadata: {},
          created_at: "2026-04-04T12:00:00Z",
        },
        {
          id: "msg-2",
          role: "assistant",
          content: "JWT-based auth.",
          source: "knowledge_cache",
          tokens_used: 0,
          rating: null,
          metadata: {},
          created_at: "2026-04-04T12:00:01Z",
        },
      ],
      fromCache: false,
    });

    queryResponses.set("UPDATE instinct_conversations", {
      rows: [{ id: "conv-1" }],
      fromCache: false,
    });

    const ok = await archiveConversation("conv-1", "u1");
    expect(ok).toBe(true);

    const archiveCalls = queryLog.filter((q) =>
      q.text.includes("status = 'archived'"),
    );
    expect(archiveCalls.length).toBe(1);
  });

  test("returns false when conversation not found", async () => {
    const ok = await archiveConversation("nonexistent", "u1");
    expect(ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// User memory
// ---------------------------------------------------------------------------

describe("user memory", () => {
  test("getUserMemory loads from DB", async () => {
    queryResponses.set("SELECT id, memory_type, key, value", {
      rows: [
        {
          id: "mem-1",
          memory_type: "preference",
          key: "theme",
          value: "dark",
          confidence: 1.0,
          source: "explicit",
        },
      ],
      fromCache: false,
    });

    const memory = await getUserMemory("u1");
    expect(memory).toHaveLength(1);
    expect(memory[0].key).toBe("theme");
    expect(memory[0].value).toBe("dark");
    expect(memory[0].memoryType).toBe("preference");
  });

  test("setUserMemory upserts into DB", async () => {
    await setUserMemory("u1", "preference", "theme", "dark", "explicit");

    const upsertCalls = queryLog.filter((q) =>
      q.text.includes("INSERT INTO instinct_user_memory"),
    );
    expect(upsertCalls.length).toBe(1);
    expect(upsertCalls[0].params).toContain("u1");
    expect(upsertCalls[0].params).toContain("preference");
    expect(upsertCalls[0].params).toContain("theme");
    expect(upsertCalls[0].params).toContain("dark");
    expect(upsertCalls[0].params).toContain("explicit");
  });

  test("topics from messages are stored in user memory", async () => {
    await chat("How do I manage inventory?", "u1", "dev");

    // Should have stored a topic memory for "inventory"
    const memoryCalls = queryLog.filter(
      (q) =>
        q.text.includes("INSERT INTO instinct_user_memory") &&
        q.params.includes("topic"),
    );
    expect(memoryCalls.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Topic auto-detection
// ---------------------------------------------------------------------------

describe("autoDetectTopics", () => {
  test("detects inventory topics", () => {
    expect(autoDetectTopics("How do I update inventory?")).toContain("inventory");
  });

  test("detects leads topics", () => {
    expect(autoDetectTopics("Show me the lead pipeline")).toContain("leads");
  });

  test("detects pricing topics", () => {
    expect(autoDetectTopics("What is the pricing model?")).toContain("pricing");
  });

  test("detects analytics topics", () => {
    expect(autoDetectTopics("Show me the dashboard metrics")).toContain("analytics");
  });

  test("detects security topics", () => {
    expect(autoDetectTopics("How does auth work?")).toContain("security");
  });

  test("detects compliance topics", () => {
    expect(autoDetectTopics("What about GDPR compliance?")).toContain("compliance");
  });

  test("detects onboarding topics", () => {
    expect(autoDetectTopics("How do I get started with setup?")).toContain("onboarding");
  });

  test("detects payments topics", () => {
    expect(autoDetectTopics("How does billing work?")).toContain("payments");
  });

  test("detects multiple topics", () => {
    const topics = autoDetectTopics("How do I configure payment integration for inventory?");
    expect(topics.length).toBeGreaterThanOrEqual(2);
    expect(topics).toContain("inventory");
    expect(topics).toContain("payments");
  });

  test("returns empty array for generic messages", () => {
    expect(autoDetectTopics("Hello there")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Conversation summary generation
// ---------------------------------------------------------------------------

describe("generateConversationSummary", () => {
  test("produces summary from messages", () => {
    const messages: AssistantMessage[] = [
      { role: "user", content: "How does auth work?", tokensUsed: 0, timestamp: "2026-01-01T00:00:00Z" },
      { role: "assistant", content: "JWT-based auth with role hierarchy.", source: "knowledge_cache", tokensUsed: 0, timestamp: "2026-01-01T00:00:01Z" },
      { role: "user", content: "What about API keys?", tokensUsed: 0, timestamp: "2026-01-01T00:00:02Z" },
      { role: "assistant", content: "API keys are managed via the settings page.", source: "ai", tokensUsed: 100, timestamp: "2026-01-01T00:00:03Z" },
    ];

    const summary = generateConversationSummary(messages);

    expect(summary).toContain("How does auth work?");
    expect(summary).toContain("What about API keys?");
    expect(summary).toContain("4 messages");
    expect(summary).toContain("100 tokens used");
  });

  test("skips fallback answers in summary", () => {
    const messages: AssistantMessage[] = [
      { role: "user", content: "Random question", tokensUsed: 0, timestamp: "2026-01-01T00:00:00Z" },
      { role: "assistant", content: "Could not find answer", source: "fallback", tokensUsed: 0, timestamp: "2026-01-01T00:00:01Z" },
    ];

    const summary = generateConversationSummary(messages);

    expect(summary).toContain("Random question");
    expect(summary).not.toContain("Could not find answer");
  });

  test("truncates long answer previews", () => {
    const messages: AssistantMessage[] = [
      { role: "user", content: "Tell me everything", tokensUsed: 0, timestamp: "2026-01-01T00:00:00Z" },
      { role: "assistant", content: "x".repeat(200), source: "ai", tokensUsed: 500, timestamp: "2026-01-01T00:00:01Z" },
    ];

    const summary = generateConversationSummary(messages);
    expect(summary).toContain("...");
  });
});

// ---------------------------------------------------------------------------
// Legacy compatibility
// ---------------------------------------------------------------------------

describe("getConversationHistory (legacy compat)", () => {
  test("returns messages for a conversation", async () => {
    queryResponses.set("SELECT id, role, content, source", {
      rows: [
        {
          id: "msg-1",
          role: "user",
          content: "Hello",
          source: null,
          tokens_used: 0,
          rating: null,
          metadata: {},
          created_at: "2026-04-04T12:00:00Z",
        },
      ],
      fromCache: false,
    });

    const history = await getConversationHistory("conv-1");
    expect(history).toHaveLength(1);
    expect(history[0].content).toBe("Hello");
  });
});

// ---------------------------------------------------------------------------
// Page context
// ---------------------------------------------------------------------------

describe("page context", () => {
  test("page context stored in message metadata", async () => {
    await chat("What reports are available?", "u1", "dev", undefined, "User is viewing the reports page");

    // Check the user message insert has metadata with pageContext
    const msgInserts = queryLog.filter(
      (q) => q.text.includes("INSERT INTO instinct_messages") && q.params.includes("user"),
    );
    expect(msgInserts.length).toBeGreaterThanOrEqual(1);

    // The metadata param (index 6) should contain pageContext
    const metadataParam = msgInserts[0].params[6] as string;
    const metadata = JSON.parse(metadataParam);
    expect(metadata.pageContext).toBe("User is viewing the reports page");
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

  test("topics included in question_asked event", async () => {
    await chat("How do I manage inventory?", "u1", "dev");

    expect(mockTrackEvent).toHaveBeenCalledWith(
      "knowledge.question_asked",
      "u1",
      "dev",
      expect.objectContaining({
        topics: expect.stringContaining("inventory"),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Zero-token tracking
// ---------------------------------------------------------------------------

describe("zero-token tracking", () => {
  test("knowledge cache hit uses 0 tokens", async () => {
    mockSearchKnowledge.mockResolvedValue([
      {
        id: "k-1",
        question: "Test",
        answer: "Cached",
        source: "docs",
        rating: 5,
        view_count: 1,
        tokens_used: 0,
        tags: [],
      },
    ]);

    const result = await chat("Test", "u1", "dev");
    expect(result.tokensUsed).toBe(0);
    expect(result.source).toBe("knowledge_cache");
  });

  test("fallback uses 0 tokens", async () => {
    const result = await chat("Unknown question with no keywords", "u1", "dev");
    expect(result.tokensUsed).toBe(0);
  });

  test("AI response tokens are tracked", async () => {
    mockAIComplete.mockResolvedValueOnce({
      content: "AI response",
      model_used: "test-model",
      provider_used: "test-provider",
      input_tokens: 200,
      output_tokens: 100,
      cost_usd: 0,
      latency_ms: 1,
    });

    const result = await chat("Generic question", "u1", "dev");
    expect(result.tokensUsed).toBe(300);
    expect(result.source).toBe("ai");
  });
});

// ---------------------------------------------------------------------------
// SharePoint + MS Project context grounding (callAI path)
// ---------------------------------------------------------------------------

describe("context grounding via getRelevantContext", () => {
  test("AI call prepends rendered_prompt_block to system prompt", async () => {
    const groundingBlock =
      "Internal context (cite if you use it):\n\n[SharePoint] TWA Agenda 4.20 - https://netorg9503444.sharepoint.com/sites/WolfpackInternal/TWA_Agenda_4.20.docx\nDiscuss Q2 OKRs.\n";
    mockGetRelevantContext.mockResolvedValueOnce({
      question: "what was on the wolfpack internal agenda for 4/20",
      surface: "assistant_support",
      sharepoint_hits: [{}],
      project_tasks: [],
      rendered_prompt_block: groundingBlock,
      total_chars: groundingBlock.length,
      took_ms: 5,
    });

    mockAIComplete.mockResolvedValueOnce({
      content: "Per the agenda, Q2 OKRs were discussed.",
      model_used: "test-model",
      provider_used: "test-provider",
      input_tokens: 50,
      output_tokens: 20,
      cost_usd: 0,
      latency_ms: 1,
    });

    const result = await chat(
      "what was on the wolfpack internal agenda for 4/20",
      "user-1",
      "cto",
    );

    expect(result.source).toBe("ai");

    /* Resolver invoked with the user's actual id + role + question. */
    expect(mockGetRelevantContext).toHaveBeenCalledWith(
      expect.objectContaining({
        question: "what was on the wolfpack internal agenda for 4/20",
        userId: "user-1",
        role: "cto",
        surface: "assistant_support",
      }),
    );

    /* The AI router request's `system` field must contain the grounding block. */
    expect(mockAIComplete).toHaveBeenCalledTimes(1);
    const req = mockAIComplete.mock.calls[0][0];
    expect(req.system).toContain(groundingBlock);
    /* Base assistant prompt must still be present. */
    expect(req.system).toContain("OGIAM Assistant");
  });

  test("AI call still fires with unchanged system prompt when getRelevantContext throws", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";

    mockGetRelevantContext.mockRejectedValueOnce(new Error("graph 503"));

    mockAIComplete.mockResolvedValueOnce({
      content: "Generic answer.",
      model_used: "test-model",
      provider_used: "test-provider",
      input_tokens: 10,
      output_tokens: 5,
      cost_usd: 0,
      latency_ms: 1,
    });

    const result = await chat("a generic question", "user-2", "dev");

    expect(result.source).toBe("ai");
    expect(mockAIComplete).toHaveBeenCalledTimes(1);
    const req = mockAIComplete.mock.calls[0][0];
    /* No grounding header was prepended. */
    expect(req.system).not.toContain("Internal context");
    expect(req.system).toContain("OGIAM Assistant");
  });
});

// ---------------------------------------------------------------------------
// shouldBypassKnowledgeCache — meeting / date-bound query detector
// ---------------------------------------------------------------------------

describe("shouldBypassKnowledgeCache", () => {
  const positives: Array<[string, string]> = [
    ["meeting keyword", "what did we cover in the meeting"],
    ["plural meetings", "list our meetings this quarter"],
    ["discussed verb", "what was discussed last sprint"],
    ["agenda", "share the agenda for the kickoff"],
    ["transcript", "find the transcript from yesterday"],
    ["call with", "summarize my call with Aidan"],
    ["call on", "what was the call on Tuesday about"],
    ["full month name", "what happened in April"],
    ["short month name", "anything from Mar 2026?"],
    ["yesterday", "what did I miss yesterday"],
    ["today", "what's on the schedule today"],
    ["tomorrow", "anything tomorrow morning"],
    ["this week", "what's happening this week"],
    ["last week", "summary from last week"],
    ["next week", "next week's plan"],
    ["ISO date", "notes from 2026-04-20"],
    ["US slash date", "anything on 4/20/2026"],
    ["short slash date", "schedule for 4/20/26"],
    ["original prod symptom", "which meetings did wolfpack have on April 20, 2026?"],
    ["other prod symptom", "what was discussed in meetings on April 20, 2026"],
    /* New prod symptom (2026-04-30): "what's in the TWA Agenda 4.20 doc?"
       was caught by page-facts (matched on "doc"), returning a canned
       Instinct Docs blurb. The bypass regex now catches document-name
       queries so the LLM gets the SharePoint context instead. */
    ["docx extension", "what's in the TWA Agenda 4.20.docx?"],
    ["pdf extension", "summarize the Q1 report.pdf"],
    ["xlsx extension with dot", "open the budget.xlsx"],
    ["the X doc pattern", "what's in the TWA agenda doc"],
    ["the X document pattern", "summarize the onboarding document"],
    ["the X report pattern", "what does the Q1 report say"],
    ["spreadsheet noun", "show the spreadsheet from last quarter"],
    ["deck noun", "what was in the pitch deck"],
  ];

  for (const [name, q] of positives) {
    test(`bypasses for ${name}: "${q}"`, () => {
      expect(shouldBypassKnowledgeCache(q)).toBe(true);
    });
  }

  const negatives: Array<[string, string]> = [
    ["empty", ""],
    ["pricing question", "how does our pricing work"],
    ["auth question", "how does auth work"],
    ["team question", "who is on the engineering team"],
    ["no date or meeting", "what does Wolfpack do"],
  ];

  for (const [name, q] of negatives) {
    test(`does not bypass for ${name}: "${q}"`, () => {
      expect(shouldBypassKnowledgeCache(q)).toBe(false);
    });
  }
});

// ---------------------------------------------------------------------------
// Knowledge cache bypass integration
// ---------------------------------------------------------------------------

describe("knowledge cache bypass for meeting / date queries", () => {
  test("does NOT call searchKnowledge when bypass triggers, AND fires bypass event", async () => {
    /* Even if a stale knowledge entry would have matched, we never look. */
    mockSearchKnowledge.mockResolvedValue([
      {
        id: "k-stale",
        question: "wolfpack team",
        answer: "Stale team list",
        source: "docs",
        rating: 5,
        view_count: 99,
        tokens_used: 0,
        tags: ["wolfpack"],
      },
    ]);

    mockAIComplete.mockResolvedValueOnce({
      content: "Per the meeting on April 20, we discussed Q2 OKRs.",
      model_used: "test-model",
      provider_used: "test-provider",
      input_tokens: 30,
      output_tokens: 20,
      cost_usd: 0,
      latency_ms: 1,
    });

    /* Provide a meeting-grounded bundle so the LLM has fresh context. */
    const groundingBlock =
      "Internal context (cite if you use it):\n\n[Meeting] Wolfpack sync — 2026-04-20T15:00:00Z\nDiscussed Q2 OKRs.\n";
    mockGetRelevantContext.mockResolvedValueOnce({
      question: "which meetings did wolfpack have on April 20, 2026?",
      surface: "assistant_support",
      sharepoint_hits: [],
      project_tasks: [],
      meeting_notes: [
        {
          id: "m-1",
          title: "Wolfpack sync",
          occurred_at: "2026-04-20T15:00:00Z",
          snippet: "Discussed Q2 OKRs.",
          source_kind: "plaud",
          url: "/meetings/m-1",
        },
      ],
      rendered_prompt_block: groundingBlock,
      total_chars: groundingBlock.length,
      took_ms: 6,
    });

    const result = await chat(
      "which meetings did wolfpack have on April 20, 2026?",
      "u-1",
      "cto",
    );

    /* Cache must NOT have been touched. */
    expect(mockSearchKnowledge).not.toHaveBeenCalled();
    /* Bypass analytics fired. */
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "assistant.knowledge_cache_bypassed",
      "u-1",
      "cto",
      expect.objectContaining({ reason: "meeting_or_date_query" }),
    );
    /* LLM was reached and the meeting block was in the system prompt. */
    expect(result.source).toBe("ai");
    expect(mockAIComplete).toHaveBeenCalledTimes(1);
    const req = mockAIComplete.mock.calls[0][0];
    expect(req.system).toContain("[Meeting]");
    expect(req.system).toContain("Wolfpack sync");
  });

  test("non-bypass questions still go through searchKnowledge (no regression)", async () => {
    mockSearchKnowledge.mockResolvedValue([
      {
        id: "k-1",
        question: "How does auth work?",
        answer: "JWT-based auth.",
        source: "docs",
        rating: 5,
        view_count: 1,
        tokens_used: 0,
        tags: [],
        /* High similarity: same topic, slight rephrase. */
        sim: 0.78,
      },
    ]);
    const result = await chat("How does auth work?", "u-1", "cto");
    expect(mockSearchKnowledge).toHaveBeenCalledTimes(1);
    expect(result.source).toBe("knowledge_cache");
    /* Bypass event NOT emitted. */
    const bypassed = mockTrackEvent.mock.calls.filter(
      (c: any[]) => c[0] === "assistant.knowledge_cache_bypassed",
    );
    expect(bypassed).toHaveLength(0);
  });
});

/* ---------------------------------------------------------------------
 * Regression 2026-05-14 — KB similarity quality gate.
 *
 * The bug: searchKnowledge uses Postgres trigram similarity > 0.1 as
 * the SQL retrieval floor (so a slightly-rephrased question still
 * finds the right entry). tryKnowledgeBase was returning the top hit
 * with no further quality gate, so "what is Nurburgring?" loose-
 * matched "what is Morning Briefing?" on the shared "what is "
 * trigrams (~0.25 sim) and served the unrelated Morning Briefing
 * answer — never falling through to the LLM.
 *
 * These tests pin the contract: a loose-similarity hit must NOT
 * short-circuit the LLM. The threshold lives in assistant.ts as
 * KB_MIN_SIMILARITY (currently 0.45).
 * --------------------------------------------------------------- */
describe("regression 2026-05-14 — KB similarity quality gate", () => {
  test("low-similarity hit (cross-topic) does NOT short-circuit as KB answer", async () => {
    /* Loose trigram match — different topic, just "what is " overlap.
       This is the EXACT shape of the prod regression: a "what is X"
       question hit the trigram floor against a "what is Y" KB entry
       and served Y's answer with a "From knowledge base" badge. */
    mockSearchKnowledge.mockResolvedValue([
      {
        id: "k-briefing",
        question: "what is Morning Briefing?",
        answer: "The Morning Briefing appears at the top of the dashboard…",
        source: "docs",
        rating: 5,
        view_count: 1,
        tokens_used: 0,
        tags: [],
        sim: 0.25,
      },
    ]);

    const result = await chat("what is Nurburgring?", "u-1", "cto");
    /* The whole point of the gate: do NOT serve the unrelated entry.
       Whatever the downstream source ends up being (ai / cannot_answer /
       grounding-derived), it must NOT be knowledge_cache, and the
       Morning-Briefing text must NOT appear in the response. */
    expect(result.source).not.toBe("knowledge_cache");
    expect(result.response).not.toContain("Morning Briefing");
  });

  test("high-similarity hit (same topic, slight rephrase) still serves from KB", async () => {
    mockSearchKnowledge.mockResolvedValue([
      {
        id: "k-auth",
        question: "How does the auth system work?",
        answer: "JWT-based auth with 15-minute access tokens.",
        source: "docs",
        rating: 5,
        view_count: 1,
        tokens_used: 0,
        tags: [],
        /* Same topic, different wording — trigram sim ≈ 0.55. */
        sim: 0.55,
      },
    ]);
    const result = await chat("how does auth work", "u-1", "cto");
    expect(result.source).toBe("knowledge_cache");
    expect(result.response).toContain("JWT");
  });

  test("missing sim (e.g. demo entry) bypasses the gate (back-compat)", async () => {
    /* DEMO_ENTRIES in shadow mode don't carry sim; preserving the old
       permissive behavior for that small curated set is intentional. */
    mockSearchKnowledge.mockResolvedValue([
      {
        id: "k-demo",
        question: "How does auth work?",
        answer: "JWT.",
        source: "docs",
        rating: 5,
        view_count: 1,
        tokens_used: 0,
        tags: [],
        /* sim is undefined */
      },
    ]);
    const result = await chat("how does auth work", "u-1", "cto");
    expect(result.source).toBe("knowledge_cache");
  });
});

// ---------------------------------------------------------------------------
// Prod regression guard (2026-04-30): callAI uses the AI router, not a
// hard-coded Anthropic fetch. Before this fix, callAI returned null on
// Instinct prod (Azure-only env, no ANTHROPIC_API_KEY), causing every
// /assistant query to fall through to the "I don't have information"
// canned reply with badge "Zero tokens / No match found". This test
// pins the contract: when a provider IS configured, the meeting query
// reaches the LLM and the meeting context block is in the system prompt.
// ---------------------------------------------------------------------------

describe("regression 2026-04-30 — callAI routes through AI router", () => {
  test("meeting query with provider configured reaches LLM via getAIClient", async () => {
    mockAIComplete.mockResolvedValueOnce({
      content: "Discussed Q2 OKRs at the April 20 meeting.",
      model_used: "azure-gpt-4o",
      provider_used: "azure-openai",
      input_tokens: 25,
      output_tokens: 15,
      cost_usd: 0,
      latency_ms: 1,
    });

    const groundingBlock =
      "Internal context (cite if you use it):\n\n[Meeting] April 20 sync — 2026-04-20T15:00:00Z\nDiscussed Q2 OKRs.\n";
    mockGetRelevantContext.mockResolvedValueOnce({
      question: "what did we discuss in the March porsche meetings?",
      surface: "assistant_support",
      sharepoint_hits: [],
      project_tasks: [],
      meeting_notes: [
        {
          id: "m-1",
          title: "April 20 sync",
          occurred_at: "2026-04-20T15:00:00Z",
          snippet: "Discussed Q2 OKRs.",
          source_kind: "plaud",
        },
      ],
      rendered_prompt_block: groundingBlock,
      total_chars: groundingBlock.length,
      took_ms: 6,
    });

    const result = await chat(
      "what did we discuss in the March porsche meetings?",
      "u-real",
      "cto",
    );

    /* The exact prod symptom that triggered this fix:
       source must NOT be "fallback" / "page_facts" / "knowledge_cache". */
    expect(result.source).toBe("ai");
    expect(result.tokensUsed).toBe(40);

    /* getAIClient().complete() is the only path now — no direct fetch
       to api.anthropic.com. We assert via the mock that received the
       call that it carried the grounding block. */
    expect(mockAIComplete).toHaveBeenCalledTimes(1);
    const req = mockAIComplete.mock.calls[0][0];
    expect(req.system).toContain("[Meeting]");
    expect(req.system).toContain("April 20 sync");
    /* Provider-agnostic: the request shape is the AI router contract,
       not the Anthropic-specific shape. */
    expect(req).toEqual(
      expect.objectContaining({
        max_tokens: 2048,
        model_tier: "standard",
        latency_target: "real_time",
      }),
    );
  });

  test("identical org-wide question is served from instinct_messages cache at zero tokens", async () => {
    /* The cache helper short-circuits when DATABASE_URL is missing — set
       a dummy value so the SELECT actually runs against our SQL mock. */
    process.env.DATABASE_URL = "postgres://test";
    /* Seed the SQL mock so the exact-match SELECT against
       instinct_messages returns a prior assistant answer with
       tokens_used > 0. The cache lookup query contains the literal
       'JOIN LATERAL' string and 'NOT (not_helpful_count' is NOT in
       it, so we key the override on a uniquely-identifying token. */
    queryResponses = new Map();
    queryResponses.set("LATERAL", {
      rows: [
        {
          message_id: "msg-prev-1",
          answer: "On April 21, 2026, Wolfpack had 1 meeting:\n- Status call",
          source: "ai",
          tokens_used: 944,
        },
      ],
      fromCache: false,
    });

    const result = await chat(
      "which meetings did wolfpack have on April 21, 2026?",
      "u-second-asker",
      "cto",
    );

    expect(result.source).toBe("user_qa_cache");
    expect(result.tokensUsed).toBe(0);
    expect(result.response).toContain("Wolfpack had 1 meeting");
    /* AI must NOT have been called — the whole point is zero tokens. */
    expect(mockAIComplete).not.toHaveBeenCalled();
  });

  test("meeting query with NO provider configured still falls back to canned reply (preserves UX)", async () => {
    /* Default mock setup makes getAIClient throw NoProviderAvailableError
       (see beforeEach). This test confirms the historical fallback
       behavior is preserved when neither Anthropic nor Azure is wired. */
    const result = await chat(
      "which meetings did wolfpack have on April 20, 2026?",
      "u-1",
      "cto",
    );

    expect(result.source).toBe("fallback");
    expect(result.tokensUsed).toBe(0);
    /* AI client WAS attempted (we no longer short-circuit on missing
       ANTHROPIC_API_KEY env var). */
    expect(mockAIComplete).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Fallback chips — role-tailored starter prompts inlined on dead-end
// responses. Renders as clickable chips in the chat UI; presence of the
// fallbackChips field is the UI's gate.
//
// Acceptance rules being asserted here:
//   1. Bare-fallback path (no AI provider) carries the role-tailored chip
//      kit (size owned by welcome-prompts.ts; 3-6 per the coverage guard)
//   2. Successful tool / knowledge / RAG hits do NOT carry chips
//   3. Chip text reflects the user role passed into chat()
//   4. assistant.fallback_chips_offered analytics event fires once per
//      fallback response with { role, chip_count: <kit size>, source }
// ---------------------------------------------------------------------------

describe("fallback chips", () => {
  /* Pull the canonical role-mapping straight from the source of truth
     so the test breaks loudly if either side drifts. We assert against
     this map, not hard-coded literals — the welcome-prompts module
     owns the strings, this test owns the wiring. */
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { welcomePromptTextsForRole } = require("@/lib/assistant/welcome-prompts");

  test("bare fallback path (no AI provider) carries the role-tailored chip kit", async () => {
    const result = await chat("Unknown question with no keywords", "u1", "cto");

    const ctoKit = welcomePromptTextsForRole("cto");
    expect(result.source).toBe("fallback");
    expect(result.fallbackChips).toBeDefined();
    /* Kit size is owned by welcome-prompts.ts (3-6, per the welcome-
       prompts-coverage guard). Assert against the source-of-truth kit,
       not a hard-coded count, so a deliberate kit resize doesn't break
       the wiring test. */
    expect(result.fallbackChips!.length).toBe(ctoKit.length);
    expect(result.fallbackChips).toEqual(ctoKit);
  });

  test("fallback prose appends 'Try one of these instead:' lead-in", async () => {
    const result = await chat("Unknown question no keywords", "u1", "cto");

    expect(result.source).toBe("fallback");
    expect(result.response).toContain("Try one of these instead:");
  });

  test("chips reflect role: cto kit differs from pm kit", async () => {
    const ctoResult = await chat("Unknown question no keywords", "u1", "cto");
    const pmResult = await chat("Unknown question no keywords", "u2", "pm");

    expect(ctoResult.fallbackChips).toEqual(welcomePromptTextsForRole("cto"));
    expect(pmResult.fallbackChips).toEqual(welcomePromptTextsForRole("pm"));
    /* Sanity-check the two kits diverge — if welcomePromptTextsForRole
       ever collapsed all roles to the same list, this test would still
       pass on equality but the role-aware wiring would be dead. */
    expect(ctoResult.fallbackChips).not.toEqual(pmResult.fallbackChips);
  });

  test("unknown role still gets the generic kit", async () => {
    const result = await chat("Unknown question no keywords", "u1", "intern-not-in-roster");

    const genericKit = welcomePromptTextsForRole("intern-not-in-roster");
    expect(result.fallbackChips).toBeDefined();
    /* Generic-kit size is owned by welcome-prompts.ts; assert parity
       with the source kit rather than a hard-coded count. */
    expect(result.fallbackChips).toEqual(genericKit);
    expect(genericKit.length).toBeGreaterThanOrEqual(3);
    expect(genericKit.length).toBeLessThanOrEqual(6);
  });

  test("fires assistant.fallback_chips_offered analytics with role + count + source", async () => {
    await chat("Unknown question no keywords", "u1", "cto");

    const ctoKit = welcomePromptTextsForRole("cto");
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "assistant.fallback_chips_offered",
      "u1",
      "cto",
      expect.objectContaining({
        role: "cto",
        /* chip_count mirrors the kit size owned by welcome-prompts.ts. */
        chip_count: ctoKit.length,
        source: "fallback",
      }),
    );
  });

  test("knowledge_cache hit does NOT carry fallbackChips", async () => {
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

    const result = await chat("How does auth work?", "u1", "cto");

    expect(result.source).toBe("knowledge_cache");
    expect(result.fallbackChips).toBeUndefined();
  });

  test("knowledge_cache hit does NOT fire fallback_chips_offered analytics", async () => {
    mockSearchKnowledge.mockResolvedValue([
      {
        id: "k-1",
        question: "How does auth work?",
        answer: "JWT-based auth.",
        source: "docs",
        rating: 5,
        view_count: 10,
        tokens_used: 0,
        tags: ["auth"],
      },
    ]);

    await chat("How does auth work?", "u1", "cto");

    expect(mockTrackEvent).not.toHaveBeenCalledWith(
      "assistant.fallback_chips_offered",
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  test("successful AI response (not rejected) does NOT carry fallbackChips", async () => {
    mockAIComplete.mockResolvedValueOnce({
      content: "Quantum computing uses qubits.",
      model_used: "test-model",
      provider_used: "test-provider",
      input_tokens: 100,
      output_tokens: 50,
      cost_usd: 0,
      latency_ms: 1,
    });

    const result = await chat("What is quantum computing?", "u1", "cto");

    expect(result.source).toBe("ai");
    /* Default brainContext has 0 hits → confidence gate does NOT fire
       (block requires hits>0 AND low score). No other quality gate
       trips on this answer, so verdict = "ok", no chips. */
    expect(result.fallbackChips).toBeUndefined();
  });
});
