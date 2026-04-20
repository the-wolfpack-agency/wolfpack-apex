/**
 * Knowledge Base Tests
 *
 * Tests cache-hit/miss, save, rate, search, gaps, and analytics events.
 * DB is mocked; shadow mode (no DATABASE_URL) returns demo data.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { trackEvent } from "@/lib/analytics";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
const mockQuery = jest.fn();
const mockSafeQuery = jest.fn();

jest.mock("@/lib/db", () => ({
  query: (...args: any[]) => mockQuery(...args),
  safeQuery: (...args: any[]) => mockSafeQuery(...args),
}));

jest.mock("@/lib/analytics", () => ({
  trackEvent: jest.fn(),
}));

import {
  askQuestion,
  saveAnswer,
  rateAnswer,
  getPopularQuestions,
  getKnowledgeGaps,
  searchKnowledge,
} from "@/lib/knowledge";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function setDatabaseUrl(val: string | undefined) {
  if (val === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = val;
  }
}

const FAKE_ROW = {
  id: "k-1",
  question: "How does auth work?",
  answer: "JWT-based with role hierarchy.",
  source: "docs",
  asked_by: "user-1",
  repo: null,
  file_path: null,
  confidence: 90,
  rating: 5,
  view_count: 10,
  tokens_used: 0,
  tags: ["auth"],
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

beforeEach(() => {
  jest.clearAllMocks();
});

afterEach(() => {
  delete process.env.DATABASE_URL;
});

// ---------------------------------------------------------------------------
// askQuestion
// ---------------------------------------------------------------------------
describe("askQuestion", () => {
  test("cache hit — returns answer and tracks analytics", async () => {
    setDatabaseUrl("postgres://localhost/test");
    mockQuery
      .mockResolvedValueOnce({ rows: [FAKE_ROW] }) // SELECT similarity
      .mockResolvedValueOnce({ rows: [] }); // UPDATE view_count

    const result = await askQuestion("How does auth work?", "u1", "dev");

    expect(result).not.toBeNull();
    expect(result!.id).toBe("k-1");
    expect(result!.answer).toContain("JWT");
    expect(trackEvent).toHaveBeenCalledWith(
      "knowledge.question_asked",
      "u1",
      "dev",
      expect.any(Object),
    );
    expect(trackEvent).toHaveBeenCalledWith(
      "knowledge.answer_found",
      "u1",
      "dev",
      expect.objectContaining({ knowledge_id: "k-1", source: "cache", tokens_used: 0 }),
    );
  });

  test("cache miss — returns null and tracks not_found", async () => {
    setDatabaseUrl("postgres://localhost/test");
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await askQuestion("What is quantum computing?", "u1", "dev");

    expect(result).toBeNull();
    expect(trackEvent).toHaveBeenCalledWith(
      "knowledge.answer_not_found",
      "u1",
      "dev",
      expect.any(Object),
    );
  });

  test("shadow mode — returns demo data for matching question", async () => {
    setDatabaseUrl(undefined);

    const result = await askQuestion("How does the auth system work?", "u1", "dev");

    expect(result).not.toBeNull();
    expect(result!.id).toBe("demo-k1");
    expect(trackEvent).toHaveBeenCalledWith(
      "knowledge.answer_found",
      "u1",
      "dev",
      expect.objectContaining({ source: "cache" }),
    );
  });

  test("shadow mode — returns null for unmatched question", async () => {
    setDatabaseUrl(undefined);

    const result = await askQuestion("zzzz no match zzzz", "u1", "dev");

    expect(result).toBeNull();
    expect(trackEvent).toHaveBeenCalledWith(
      "knowledge.answer_not_found",
      "u1",
      "dev",
      expect.any(Object),
    );
  });

  test("increments view_count on cache hit", async () => {
    setDatabaseUrl("postgres://localhost/test");
    mockQuery
      .mockResolvedValueOnce({ rows: [FAKE_ROW] })
      .mockResolvedValueOnce({ rows: [] });

    await askQuestion("auth", "u1", "dev");

    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE instinct_knowledge SET view_count"),
      ["k-1"],
    );
  });
});

// ---------------------------------------------------------------------------
// saveAnswer
// ---------------------------------------------------------------------------
describe("saveAnswer", () => {
  test("inserts and returns entry", async () => {
    setDatabaseUrl("postgres://localhost/test");
    mockQuery.mockResolvedValueOnce({ rows: [FAKE_ROW] });

    const result = await saveAnswer("Q?", "A.", "human", "u1", "repo", "file.ts", 0);

    expect(result).not.toBeNull();
    expect(result!.id).toBe("k-1");
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO instinct_knowledge"),
      ["Q?", "A.", "human", "u1", "repo", "file.ts", 0],
    );
    expect(trackEvent).toHaveBeenCalledWith(
      "knowledge.answer_found",
      "u1",
      "dev",
      expect.objectContaining({ tokens_used: 0 }),
    );
  });

  test("shadow mode returns demo entry", async () => {
    setDatabaseUrl(undefined);

    const result = await saveAnswer("Q?", "A.", "human", "u1");

    expect(result).not.toBeNull();
    expect(result!.id).toMatch(/^demo-/);
    expect(result!.question).toBe("Q?");
  });
});

// ---------------------------------------------------------------------------
// rateAnswer
// ---------------------------------------------------------------------------
describe("rateAnswer", () => {
  test("updates rating and tracks event", async () => {
    setDatabaseUrl("postgres://localhost/test");
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const ok = await rateAnswer("k-1", 4, "u1");

    expect(ok).toBe(true);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE instinct_knowledge SET rating"),
      [4, "k-1"],
    );
    expect(trackEvent).toHaveBeenCalledWith(
      "knowledge.answer_rated",
      "u1",
      "dev",
      expect.objectContaining({ knowledge_id: "k-1", rating: 4 }),
    );
  });

  test("shadow mode returns true", async () => {
    setDatabaseUrl(undefined);

    const ok = await rateAnswer("k-1", 5, "u1");
    expect(ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// searchKnowledge
// ---------------------------------------------------------------------------
describe("searchKnowledge", () => {
  test("returns DB results when connected", async () => {
    setDatabaseUrl("postgres://localhost/test");
    mockSafeQuery.mockResolvedValueOnce({ rows: [FAKE_ROW], fromCache: false });

    const results = await searchKnowledge("auth");

    expect(results).toHaveLength(1);
    expect(results[0].question).toContain("auth");
  });

  test("shadow mode filters demo entries", async () => {
    setDatabaseUrl(undefined);

    const results = await searchKnowledge("auth");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].question.toLowerCase()).toContain("auth");
  });
});

// ---------------------------------------------------------------------------
// getPopularQuestions
// ---------------------------------------------------------------------------
describe("getPopularQuestions", () => {
  test("returns ordered by view_count", async () => {
    setDatabaseUrl("postgres://localhost/test");
    mockSafeQuery.mockResolvedValueOnce({ rows: [FAKE_ROW], fromCache: false });

    const results = await getPopularQuestions(5);
    expect(results).toHaveLength(1);
  });

  test("shadow mode returns demo entries", async () => {
    setDatabaseUrl(undefined);

    const results = await getPopularQuestions();
    expect(results.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// getKnowledgeGaps
// ---------------------------------------------------------------------------
describe("getKnowledgeGaps", () => {
  test("returns gaps from view", async () => {
    setDatabaseUrl("postgres://localhost/test");
    mockSafeQuery.mockResolvedValueOnce({
      rows: [{ question: "How to deploy?", times_asked: 5, last_asked: "2026-01-01" }],
      fromCache: false,
    });

    const gaps = await getKnowledgeGaps();
    expect(gaps).toHaveLength(1);
    expect(gaps[0].times_asked).toBe(5);
  });

  test("shadow mode returns demo gap", async () => {
    setDatabaseUrl(undefined);

    const gaps = await getKnowledgeGaps();
    expect(gaps.length).toBeGreaterThan(0);
    expect(gaps[0].question).toContain("deploy");
  });
});
