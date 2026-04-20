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

/* eslint-disable @typescript-eslint/no-explicit-any */

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
    process.env.ANTHROPIC_API_KEY = "test-key";

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

  test("auto-resumes recent active conversation", async () => {
    const recentConv = {
      id: "existing-conv-123",
      last_message_at: new Date().toISOString(), // Fresh
    };

    // When looking for recent conversation, return one
    queryResponses.set("SELECT id, last_message_at FROM instinct_conversations", {
      rows: [recentConv],
      fromCache: false,
    });

    const result = await chat("Hello", "u1", "dev");

    // Should reuse the existing conversation, not create a new one
    expect(result.conversationId).toBe("existing-conv-123");
  });

  test("creates new conversation when last message is stale (>2 hours)", async () => {
    const staleConv = {
      id: "stale-conv-123",
      last_message_at: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(), // 3 hours ago
    };

    queryResponses.set("SELECT id, last_message_at FROM instinct_conversations", {
      rows: [staleConv],
      fromCache: false,
    });

    const result = await chat("Hello", "u1", "dev");

    // Should create a NEW conversation since the old one is stale
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
    process.env.ANTHROPIC_API_KEY = "test-key";
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [{ text: "AI response" }],
        usage: { input_tokens: 200, output_tokens: 100 },
      }),
    }) as any;

    const result = await chat("Generic question", "u1", "dev");
    expect(result.tokensUsed).toBe(300);
    expect(result.source).toBe("ai");
  });
});
