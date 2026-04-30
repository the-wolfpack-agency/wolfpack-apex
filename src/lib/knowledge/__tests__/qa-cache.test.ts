/**
 * qa-cache unit tests.
 *
 * Mocks every external dep so the assertions exercise the cache
 * pipeline pure-logic surface only:
 *   - normalization rules
 *   - exact-match fast path
 *   - vector miss → calls the LLM
 *   - vector hit above threshold → no LLM call
 *   - below-threshold near miss → still calls the LLM
 */

const mockQuery = jest.fn();
const mockWriteQuery = jest.fn();
jest.mock("@/lib/db", () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  writeQuery: (...args: unknown[]) => mockWriteQuery(...args),
}));

const mockEmbedBatch = jest.fn();
const mockIsEmbeddingConfigured = jest.fn(() => true);
jest.mock("@/lib/brain/embedder", () => ({
  embedBatch: (...args: unknown[]) => mockEmbedBatch(...args),
  isEmbeddingConfigured: () => mockIsEmbeddingConfigured(),
}));

const mockComplete = jest.fn();
jest.mock("@/lib/ai", () => ({
  getAIClient: () => ({ complete: mockComplete }),
}));

jest.mock("@/lib/obs", () => ({
  getObsClient: () => ({ recordError: jest.fn() }),
}));

const mockGetRelevantContext = jest.fn();
jest.mock("@/lib/assistant/context-resolver", () => ({
  getRelevantContext: (...args: unknown[]) => mockGetRelevantContext(...args),
}));

import {
  askWithCache,
  cosineSimilarity,
  normalizeQuestion,
  wordJaccard,
  DEFAULT_SIM_THRESHOLD,
} from "../qa-cache";

beforeEach(() => {
  jest.clearAllMocks();
  process.env.DATABASE_URL = "postgres://test";
  /* Default: context resolver returns an empty bundle so the existing
     miss-path tests stay untouched. Individual tests override as needed. */
  mockGetRelevantContext.mockResolvedValue({
    question: "",
    surface: "knowledge",
    sharepoint_hits: [],
    project_tasks: [],
    rendered_prompt_block: "",
    total_chars: 0,
    took_ms: 1,
  });
});

afterAll(() => {
  delete process.env.DATABASE_URL;
});

describe("normalizeQuestion", () => {
  it("lowercases and collapses whitespace", () => {
    expect(normalizeQuestion("  HOW   do  I    Reset?  ")).toBe(
      "how do i reset",
    );
  });
  it("strips trailing punctuation runs", () => {
    expect(normalizeQuestion("What is RLS?!?")).toBe("what is rls");
  });
  it("returns empty string for empty input", () => {
    expect(normalizeQuestion("")).toBe("");
  });
  it("collapses tabs and newlines", () => {
    expect(normalizeQuestion("how\tdo\nI\treset")).toBe("how do i reset");
  });
});

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors", () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1, 5);
  });
  it("returns 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 5);
  });
  it("returns NaN on length mismatch", () => {
    expect(Number.isNaN(cosineSimilarity([1, 0], [1, 0, 0]))).toBe(true);
  });
});

describe("wordJaccard", () => {
  it("scores high on near-paraphrases", () => {
    /* "reset password" tokens overlap fully → high score. */
    expect(wordJaccard("how do i reset my password", "how to reset password"))
      .toBeGreaterThan(0.7);
  });
  it("scores low on unrelated questions", () => {
    expect(
      wordJaccard("how do i reset my password", "what is the deploy URL"),
    ).toBeLessThan(0.3);
  });
});

describe("askWithCache — exact match fast path", () => {
  it("returns cached answer without embedding or LLM", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "qa-exact",
          question_text: "How do I reset my password?",
          question_normalized: "how do i reset my password",
          question_embedding: null,
          answer_text: "Click your avatar and choose Reset password.",
          source: "human_curated",
          ai_model: null,
          ai_generated_at: null,
          surface: "knowledge",
          helpful_count: 2,
          not_helpful_count: 0,
          lookup_count: 5,
        },
      ],
    });
    mockWriteQuery.mockResolvedValueOnce({ rows: [] });

    const result = await askWithCache({
      question: "How do I reset my password?",
      surface: "knowledge",
    });

    expect(result.was_cache_hit).toBe(true);
    expect(result.answer).toContain("Reset password");
    expect(mockEmbedBatch).not.toHaveBeenCalled();
    expect(mockComplete).not.toHaveBeenCalled();
  });
});

describe("askWithCache — semantic hit above threshold", () => {
  it("returns the nearest cached row without calling the LLM", async () => {
    /* Exact-match miss. */
    mockQuery.mockResolvedValueOnce({ rows: [] });
    /* Embedder returns a deterministic vector. */
    mockEmbedBatch.mockResolvedValueOnce({
      vectors: [[1, 0, 0, 0]],
      tokensUsed: 1,
      model: "test-model",
    });
    /* Candidate set: one row whose stored embedding is identical → cosine 1. */
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "qa-near",
          question_text: "I forgot my password",
          question_normalized: "i forgot my password",
          question_embedding: { dim: 4, model: "test-model", vector: [1, 0, 0, 0] },
          answer_text: "Use the reset link on the login page.",
          source: "ai_generated",
          ai_model: "test/test-haiku",
          ai_generated_at: "2026-04-29T00:00:00Z",
          surface: "knowledge",
          helpful_count: 1,
          not_helpful_count: 0,
          lookup_count: 3,
        },
      ],
    });
    mockWriteQuery.mockResolvedValueOnce({ rows: [] });

    const result = await askWithCache({
      question: "How do I reset my password",
      surface: "knowledge",
    });

    expect(result.was_cache_hit).toBe(true);
    expect(result.qa_id).toBe("qa-near");
    expect(result.similarity).toBeGreaterThanOrEqual(DEFAULT_SIM_THRESHOLD);
    expect(mockComplete).not.toHaveBeenCalled();
  });
});

describe("askWithCache — vector miss calls the LLM", () => {
  it("calls the LLM and inserts a new ai_generated row", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }); // exact miss
    mockEmbedBatch.mockResolvedValueOnce({
      vectors: [[1, 0, 0, 0]],
      tokensUsed: 1,
      model: "test-model",
    });
    /* No candidates at all → guaranteed miss. */
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockComplete.mockResolvedValueOnce({
      content: "Here's how you do it.",
      model_used: "claude-haiku-4.5",
      provider_used: "anthropic",
      input_tokens: 12,
      output_tokens: 8,
      cost_usd: 0,
      latency_ms: 42,
    });
    mockWriteQuery.mockResolvedValueOnce({ rows: [{ id: "qa-new" }] });

    const result = await askWithCache({
      question: "Brand-new question we have never seen",
      surface: "knowledge",
    });

    expect(result.was_cache_hit).toBe(false);
    expect(result.source).toBe("ai_generated");
    expect(result.ai_model).toBe("anthropic/claude-haiku-4.5");
    expect(result.qa_id).toBe("qa-new");
    expect(mockComplete).toHaveBeenCalledTimes(1);
  });
});

describe("askWithCache — below-threshold near miss still calls LLM", () => {
  it("does not serve a row whose similarity is under the gate", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }); // exact miss
    mockEmbedBatch.mockResolvedValueOnce({
      vectors: [[1, 0, 0, 0]],
      tokensUsed: 1,
      model: "test-model",
    });
    /* Stored vector is orthogonal → cosine 0, far below the 0.86 gate. */
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "qa-far",
          question_text: "totally unrelated",
          question_normalized: "totally unrelated",
          question_embedding: { dim: 4, model: "test-model", vector: [0, 1, 0, 0] },
          answer_text: "Unrelated answer.",
          source: "ai_generated",
          ai_model: "x",
          ai_generated_at: "2026-04-29T00:00:00Z",
          surface: "knowledge",
          helpful_count: 0,
          not_helpful_count: 0,
          lookup_count: 0,
        },
      ],
    });
    mockComplete.mockResolvedValueOnce({
      content: "Fresh answer from the model.",
      model_used: "haiku",
      provider_used: "anthropic",
      input_tokens: 10,
      output_tokens: 5,
      cost_usd: 0,
      latency_ms: 30,
    });
    mockWriteQuery.mockResolvedValueOnce({ rows: [{ id: "qa-fresh" }] });

    const result = await askWithCache({
      question: "completely different question",
      surface: "knowledge",
    });

    expect(result.was_cache_hit).toBe(false);
    expect(mockComplete).toHaveBeenCalledTimes(1);
    expect(result.qa_id).toBe("qa-fresh");
  });
});

describe("askWithCache — empty question is rejected", () => {
  it("throws a clear error", async () => {
    await expect(
      askWithCache({ question: "   ", surface: "knowledge" }),
    ).rejects.toThrow(/required/i);
  });
});

describe("askWithCache — SharePoint + MS Project context grounding", () => {
  /* Helper: stage a guaranteed cache miss so the LLM call always fires. */
  function stageCacheMiss() {
    mockQuery.mockResolvedValueOnce({ rows: [] }); // exact miss
    mockEmbedBatch.mockResolvedValueOnce({
      vectors: [[1, 0, 0, 0]],
      tokensUsed: 1,
      model: "test-model",
    });
    mockQuery.mockResolvedValueOnce({ rows: [] }); // no candidates
    mockComplete.mockResolvedValueOnce({
      content: "answer",
      model_used: "haiku",
      provider_used: "anthropic",
      input_tokens: 5,
      output_tokens: 5,
      cost_usd: 0,
      latency_ms: 10,
    });
    mockWriteQuery.mockResolvedValueOnce({ rows: [{ id: "qa-new" }] });
  }

  it("injects rendered_prompt_block from getRelevantContext into the LLM system prompt", async () => {
    const groundingBlock =
      "Internal context (cite if you use it):\n\n[SharePoint] TWA Agenda 4.20 - https://netorg9503444.sharepoint.com/sites/WolfpackInternal/TWA_Agenda_4.20.docx\nDiscuss Q2 OKRs and AI roadmap.\n";
    mockGetRelevantContext.mockResolvedValueOnce({
      question: "what is on the wolfpack internal agenda",
      surface: "knowledge",
      sharepoint_hits: [{}],
      project_tasks: [],
      rendered_prompt_block: groundingBlock,
      total_chars: groundingBlock.length,
      took_ms: 5,
    });
    stageCacheMiss();

    const result = await askWithCache({
      question: "what is on the wolfpack internal agenda",
      surface: "knowledge",
      userId: "user-1",
    });

    expect(result.was_cache_hit).toBe(false);
    expect(mockComplete).toHaveBeenCalledTimes(1);
    const completeArgs = mockComplete.mock.calls[0][0] as { system: string };
    expect(completeArgs.system).toContain(groundingBlock);
    expect(completeArgs.system).toContain("Wolfpack Agency"); // base prompt still present

    /* Resolver was called with the right shape. */
    expect(mockGetRelevantContext).toHaveBeenCalledWith(
      expect.objectContaining({
        question: "what is on the wolfpack internal agenda",
        userId: "user-1",
        surface: "knowledge",
      }),
    );
  });

  it("calls the LLM with unchanged base prompt when getRelevantContext throws", async () => {
    mockGetRelevantContext.mockRejectedValueOnce(new Error("graph 503"));
    stageCacheMiss();

    const result = await askWithCache({
      question: "another brand-new question",
      surface: "knowledge",
      userId: "user-2",
    });

    expect(result.was_cache_hit).toBe(false);
    expect(mockComplete).toHaveBeenCalledTimes(1);
    const completeArgs = mockComplete.mock.calls[0][0] as { system: string };
    /* No grounding header was prepended. */
    expect(completeArgs.system).not.toContain("Internal context");
    expect(completeArgs.system).toContain("Wolfpack Agency");
  });

  it("calls the LLM with unchanged base prompt when bundle is empty (no M365 token)", async () => {
    mockGetRelevantContext.mockResolvedValueOnce({
      question: "q",
      surface: "knowledge",
      sharepoint_hits: [],
      project_tasks: [],
      rendered_prompt_block: "",
      total_chars: 0,
      took_ms: 1,
    });
    stageCacheMiss();

    await askWithCache({
      question: "yet another question",
      surface: "knowledge",
      userId: "user-3",
    });

    const completeArgs = mockComplete.mock.calls[0][0] as { system: string };
    expect(completeArgs.system).not.toContain("Internal context");
  });
});
