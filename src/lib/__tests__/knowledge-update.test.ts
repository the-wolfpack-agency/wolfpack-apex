/**
 * updateAnswer + deleteAnswer — knowledge correction path.
 *
 * Mirrors the style of knowledge.test.ts: db.query + analytics.trackEvent
 * are mocked; DATABASE_URL toggles between real-DB and shadow-mode paths.
 */

 

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

// triple-write + neo4j imports happen at module-load time; stub them so
// importing @/lib/knowledge doesn't pull in qdrant / neo4j drivers.
jest.mock("@/lib/triple-write", () => ({
  tripleWriteKnowledge: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("@/lib/neo4j", () => ({
  recordKnowledgeInteraction: jest.fn().mockResolvedValue(undefined),
  getNeo4jHealth: jest.fn(),
}));

import { updateAnswer, deleteAnswer } from "@/lib/knowledge";

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

const UPDATED_ROW = {
  id: "k-1",
  question: "What does auth do?",
  answer: "JWT-based, 15 min TTL.",
  source: "docs",
  asked_by: "u-original",
  repo: null,
  file_path: null,
  confidence: 90,
  rating: 4,
  view_count: 3,
  tokens_used: 0,
  tags: ["auth", "security"],
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-04-22T00:00:00Z",
};

beforeEach(() => {
  jest.clearAllMocks();
});

afterEach(() => {
  delete process.env.DATABASE_URL;
});

// ---------------------------------------------------------------------------
// updateAnswer
// ---------------------------------------------------------------------------
describe("updateAnswer", () => {
  test("happy path — updates row and returns entry", async () => {
    setDatabaseUrl("postgres://localhost/test");
    mockQuery.mockResolvedValueOnce({ rows: [UPDATED_ROW] });

    const result = await updateAnswer(
      "k-1",
      "What does auth do?",
      "JWT-based, 15 min TTL.",
      "u-editor",
      ["auth", "security"],
      "docs",
    );

    expect(result).not.toBeNull();
    expect(result!.id).toBe("k-1");
    expect(result!.answer).toContain("JWT");
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, args] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/UPDATE instinct_knowledge/);
    expect(sql).toMatch(/COALESCE\(\$4, source\)/);
    expect(sql).toMatch(/COALESCE\(\$5, tags\)/);
    expect(args).toEqual([
      "k-1",
      "What does auth do?",
      "JWT-based, 15 min TTL.",
      "docs",
      ["auth", "security"],
    ]);
  });

  test("returns null when no row matches (404 case)", async () => {
    setDatabaseUrl("postgres://localhost/test");
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await updateAnswer(
      "missing",
      "Q",
      "A",
      "u-editor",
    );

    expect(result).toBeNull();
    // No entry_updated event should fire on a 0-row update.
    expect(trackEvent).not.toHaveBeenCalledWith(
      "knowledge.entry_updated",
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  test("shadow mode returns demo entry without DATABASE_URL", async () => {
    setDatabaseUrl(undefined);

    const result = await updateAnswer(
      "k-1",
      "Shadow question",
      "Shadow answer",
      "u-editor",
      ["tag"],
      "human",
    );

    expect(result).not.toBeNull();
    expect(result!.id).toBe("k-1");
    expect(result!.question).toBe("Shadow question");
    expect(result!.answer).toBe("Shadow answer");
    expect(result!.source).toBe("human");
    expect(result!.tags).toEqual(["tag"]);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test("emits knowledge.entry_updated with id + source", async () => {
    setDatabaseUrl("postgres://localhost/test");
    mockQuery.mockResolvedValueOnce({ rows: [UPDATED_ROW] });

    await updateAnswer("k-1", "Q", "A", "u-editor", undefined, undefined);

    expect(trackEvent).toHaveBeenCalledWith(
      "knowledge.entry_updated",
      "u-editor",
      "dev",
      expect.objectContaining({
        knowledge_id: "k-1",
        source: "docs",
      }),
    );
  });

  test("preserves source when not provided (passes null for COALESCE)", async () => {
    setDatabaseUrl("postgres://localhost/test");
    mockQuery.mockResolvedValueOnce({ rows: [UPDATED_ROW] });

    await updateAnswer("k-1", "Q", "A", "u-editor");

    const [, args] = mockQuery.mock.calls[0];
    // $4 = source → null (COALESCE keeps existing); $5 = tags → null too.
    expect(args[3]).toBeNull();
    expect(args[4]).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// deleteAnswer — route-layer supporting test
// ---------------------------------------------------------------------------
describe("deleteAnswer", () => {
  test("returns true and fires entry_deleted on successful delete", async () => {
    setDatabaseUrl("postgres://localhost/test");
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] });

    const ok = await deleteAnswer("k-1", "u-editor");

    expect(ok).toBe(true);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringMatching(/DELETE FROM instinct_knowledge/),
      ["k-1"],
    );
    expect(trackEvent).toHaveBeenCalledWith(
      "knowledge.entry_deleted",
      "u-editor",
      "dev",
      expect.objectContaining({ knowledge_id: "k-1" }),
    );
  });

  test("returns false when nothing was deleted (404 case)", async () => {
    setDatabaseUrl("postgres://localhost/test");
    mockQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] });

    const ok = await deleteAnswer("missing", "u-editor");

    expect(ok).toBe(false);
    expect(trackEvent).not.toHaveBeenCalledWith(
      "knowledge.entry_deleted",
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  test("shadow mode returns true without DB call", async () => {
    setDatabaseUrl(undefined);

    const ok = await deleteAnswer("k-1", "u-editor");

    expect(ok).toBe(true);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});
