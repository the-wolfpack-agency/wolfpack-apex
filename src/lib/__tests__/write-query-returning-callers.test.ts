/**
 * The three strict writes that asserted `expectRows: 1` on an UPDATE with no
 * RETURNING clause, run through the REAL writeQuery against a pg mock that
 * behaves like Postgres: rows come back only when the statement has
 * RETURNING, whatever it changed.
 *
 * Before the fix every one of these threw "row-count mismatch: expected 1,
 * got 0" on a write that had succeeded, which is how POST
 * /api/knowledge/feedback answered 500 on every thumbs-up.
 */

export {};

const mockPoolQuery = jest.fn();
jest.mock("pg", () => ({
  Pool: jest.fn(() => ({
    query: (...args: unknown[]) => mockPoolQuery(...args),
    on: jest.fn(),
    end: jest.fn(),
  })),
}));

jest.mock("@/lib/brain/embedder", () => ({
  embedBatch: jest.fn(),
  isEmbeddingConfigured: () => false,
}));
jest.mock("@/lib/ai", () => ({ getAIClient: () => ({ complete: jest.fn() }) }));
jest.mock("@/lib/obs", () => ({ getObsClient: () => ({ recordError: jest.fn() }) }));
jest.mock("@/lib/assistant/context-resolver", () => ({ getRelevantContext: jest.fn() }));
jest.mock("@/lib/analytics", () => ({ trackEvent: jest.fn() }));

/** Postgres semantics: one matching row, returned only with RETURNING. */
function postgresLike(matched: number) {
  return (text: string) =>
    Promise.resolve({
      rows: /\bRETURNING\b/i.test(text)
        ? Array.from({ length: matched }, (_, i) => ({ id: `row-${i}` }))
        : [],
      rowCount: matched,
    });
}

const ORIGINAL_DB_URL = process.env.DATABASE_URL;

beforeEach(() => {
  jest.clearAllMocks();
  jest.resetModules();
  process.env.DATABASE_URL = "postgres://test";
});

afterAll(() => {
  if (ORIGINAL_DB_URL === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = ORIGINAL_DB_URL;
});

function lastSql(): string {
  const calls = mockPoolQuery.mock.calls;
  return String(calls[calls.length - 1][0]);
}

describe("knowledge qa-cache recordFeedback", () => {
  it("succeeds when the row exists (helpful and not helpful)", async () => {
    mockPoolQuery.mockImplementation(postgresLike(1));
    const { recordFeedback } = jest.requireActual(
      "@/lib/knowledge/qa-cache",
    ) as typeof import("@/lib/knowledge/qa-cache");
    await expect(recordFeedback("qa-1", true)).resolves.toBeUndefined();
    expect(lastSql()).toMatch(/helpful_count = helpful_count \+ 1/);
    await expect(recordFeedback("qa-1", false)).resolves.toBeUndefined();
    expect(lastSql()).toMatch(/not_helpful_count/);
  });

  it("still fails loudly when the id matches no row", async () => {
    mockPoolQuery.mockImplementation(postgresLike(0));
    const { recordFeedback } = jest.requireActual(
      "@/lib/knowledge/qa-cache",
    ) as typeof import("@/lib/knowledge/qa-cache");
    await expect(recordFeedback("missing", true)).rejects.toThrow("row-count mismatch");
  });
});

describe("knowledge qa-cache exact hit bumps the hit counter", () => {
  it("issues an UPDATE that can satisfy expectRows: 1", async () => {
    mockPoolQuery.mockImplementation((text: string) => {
      if (/^\s*SELECT/i.test(text)) {
        return Promise.resolve({
          rows: [
            {
              id: "qa-9",
              question_text: "q",
              answer_text: "cached answer",
              source: "ai_generated",
              ai_model: "m",
              ai_generated_at: new Date().toISOString(),
              lookup_count: 1,
              helpful_count: 0,
              not_helpful_count: 0,
              flagged: false,
            },
          ],
          rowCount: 1,
        });
      }
      return postgresLike(1)(text);
    });
    const { askWithCache } = jest.requireActual(
      "@/lib/knowledge/qa-cache",
    ) as typeof import("@/lib/knowledge/qa-cache");
    const r = await askWithCache({ question: "q", surface: "knowledge", userId: "u" });
    expect(r.was_cache_hit).toBe(true);
    /* bumpHit is fire-and-forget; let it settle. */
    await new Promise((res) => setImmediate(res));
    const bump = mockPoolQuery.mock.calls
      .map((c) => String(c[0]))
      .find((s) => /lookup_count = lookup_count \+ 1/.test(s));
    expect(bump).toBeDefined();
    expect(bump).toMatch(/\bRETURNING\b/i);
  });
});

describe("section-comments deleteComment", () => {
  it("succeeds when the comment exists", async () => {
    mockPoolQuery.mockImplementation(postgresLike(1));
    const { deleteComment } = jest.requireActual(
      "@/lib/section-comments",
    ) as typeof import("@/lib/section-comments");
    await expect(deleteComment({ commentId: "c-1", userId: "u" })).resolves.toBeUndefined();
    expect(lastSql()).toMatch(/SET body = '\[deleted\]'/);
  });

  it("fails loudly when the comment does not exist", async () => {
    mockPoolQuery.mockImplementation(postgresLike(0));
    const { deleteComment } = jest.requireActual(
      "@/lib/section-comments",
    ) as typeof import("@/lib/section-comments");
    await expect(deleteComment({ commentId: "nope", userId: "u" })).rejects.toThrow(
      "row-count mismatch",
    );
  });
});
