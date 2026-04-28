/**
 * response-cache — unit tests.
 *
 * Mocks @/lib/db (query, writeQuery), @/lib/obs, @/lib/analytics so we
 * exercise every public function without hitting a real database.
 *
 * Covers:
 *   - normalizeForSignature collapses whitespace + lowercases
 *   - normalizeForSignature strips emails, UUIDs, ISO timestamps,
 *     wall-clock times, date words, phone numbers
 *   - signatureFor produces stable hashes across name/timestamp swaps
 *   - signatureFor differs when feature differs
 *   - signatureFor pattern_ids order does not change support.draft hash
 *   - lookupCachedResponse: returns miss when DATABASE_URL unset
 *   - lookupCachedResponse: returns miss on empty result
 *   - lookupCachedResponse: returns hit on row with positive helpful balance
 *   - lookupCachedResponse: increments hit_count + last_used_at on hit
 *   - lookupCachedResponse: fires support.cache_hit analytics on hit
 *   - lookupCachedResponse: returns miss when DB query throws
 *   - cacheResponse: returns "" cache_id when DATABASE_URL unset
 *   - cacheResponse: inserts and returns id on first call
 *   - cacheResponse: cache_id passed → bumps existing row, no insert
 *   - cacheResponse: returns "" on DB error and logs via obs
 *   - recordCacheFeedback(true): bumps helpful_count
 *   - recordCacheFeedback(false): bumps unhelpful_count
 *   - recordCacheFeedback: no-op when cache_id empty
 */

const mockQuery = jest.fn();
const mockWriteQuery = jest.fn();
const mockTrackEvent = jest.fn();
const mockRecordError = jest.fn();

jest.mock("@/lib/db", () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  writeQuery: (...args: unknown[]) => mockWriteQuery(...args),
}));

jest.mock("@/lib/analytics", () => ({
  trackEvent: (...args: unknown[]) => mockTrackEvent(...args),
}));

jest.mock("@/lib/obs", () => ({
  getObsClient: () => ({
    recordError: (...args: unknown[]) => mockRecordError(...args),
  }),
}));

import {
  cacheResponse,
  lookupCachedResponse,
  normalizeForSignature,
  recordCacheFeedback,
  signatureFor,
} from "@/lib/ai/response-cache";

const SAMPLE_AI_RESPONSE = {
  content: "Hi there, try incognito.",
  model_used: "claude-sonnet-4-6",
  provider_used: "anthropic",
  input_tokens: 100,
  output_tokens: 50,
  cost_usd: 0.001,
  latency_ms: 200,
};

beforeEach(() => {
  jest.clearAllMocks();
  process.env.DATABASE_URL =
    "postgres://test:test@localhost:5432/test";
});

afterEach(() => {
  delete process.env.DATABASE_URL;
});

/* ------------------------------------------------------------------ */
/* normalizeForSignature                                                */
/* ------------------------------------------------------------------ */

describe("normalizeForSignature", () => {
  it("lowercases all-caps tokens and collapses whitespace", () => {
    /* All-caps tokens (acronyms like AADSTS / WORLD) survive the name-
       stripping heuristic; they get lowercased + collapsed instead. */
    expect(normalizeForSignature("AADSTS   WORLD\n\nfoo")).toBe(
      "aadsts world foo",
    );
  });

  it("returns empty string for empty input", () => {
    expect(normalizeForSignature("")).toBe("");
  });

  it("strips email addresses", () => {
    const a = normalizeForSignature("contact alice@x.com about it");
    const b = normalizeForSignature("contact bob@y.com about it");
    expect(a).toBe(b);
    expect(a).not.toMatch(/@/);
  });

  it("strips UUIDs", () => {
    const a = normalizeForSignature(
      "session 11111111-1111-1111-1111-111111111111 failed",
    );
    const b = normalizeForSignature(
      "session 22222222-2222-2222-2222-222222222222 failed",
    );
    expect(a).toBe(b);
  });

  it("strips ISO 8601 timestamps", () => {
    const a = normalizeForSignature("at 2026-04-27T01:00:00.000Z it broke");
    const b = normalizeForSignature("at 2025-01-15T22:30:00Z it broke");
    expect(a).toBe(b);
  });

  it("strips wall-clock times like 9:42 AM and 3:14 PM", () => {
    const a = normalizeForSignature(
      "Lorena got an MFA prompt at 9:42 AM yesterday",
    );
    const b = normalizeForSignature(
      "Sarah got an MFA prompt at 3:14 PM today",
    );
    /* After stripping names, wall-clock times, and date words the two
       sentences should normalize identically. */
    expect(a).toBe(b);
  });

  it("strips phone numbers", () => {
    const a = normalizeForSignature("call (555) 123-4567 if locked");
    const b = normalizeForSignature("call +1 555-987-6543 if locked");
    expect(a).toBe(b);
  });
});

/* ------------------------------------------------------------------ */
/* signatureFor                                                         */
/* ------------------------------------------------------------------ */

describe("signatureFor", () => {
  it("returns the same hash for same conceptual support.draft input across name/timestamp swaps", () => {
    const a = signatureFor("support.draft", {
      feature: "support.draft",
      title: "User can't sign in",
      body: "Lorena got an MFA prompt at 9:42 AM yesterday",
      diagnostic_text: null,
      pattern_ids: ["p1", "p2"],
    });
    const b = signatureFor("support.draft", {
      feature: "support.draft",
      title: "User can't sign in",
      body: "Sarah got an MFA prompt at 3:14 PM today",
      diagnostic_text: null,
      pattern_ids: ["p1", "p2"],
    });
    expect(a).toBe(b);
  });

  it("differs when feature differs", () => {
    const a = signatureFor("support.draft", {
      feature: "support.draft",
      title: "X",
      body: "Y",
      pattern_ids: [],
    });
    const b = signatureFor("support.categorize", {
      feature: "support.categorize",
      title: "X",
      body: "Y",
    });
    expect(a).not.toBe(b);
  });

  it("returns the same hash regardless of pattern_ids order on support.draft", () => {
    const a = signatureFor("support.draft", {
      feature: "support.draft",
      title: "T",
      body: "B",
      pattern_ids: ["b", "a", "c"],
    });
    const b = signatureFor("support.draft", {
      feature: "support.draft",
      title: "T",
      body: "B",
      pattern_ids: ["a", "b", "c"],
    });
    expect(a).toBe(b);
  });
});

/* ------------------------------------------------------------------ */
/* lookupCachedResponse                                                 */
/* ------------------------------------------------------------------ */

describe("lookupCachedResponse", () => {
  it("returns hit:false when DATABASE_URL is unset", async () => {
    delete process.env.DATABASE_URL;
    const out = await lookupCachedResponse({
      feature: "support.draft",
      input: {
        feature: "support.draft",
        title: "T",
        body: "B",
        pattern_ids: [],
      },
    });
    expect(out).toEqual({ hit: false });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("returns hit:false when the table is empty", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const out = await lookupCachedResponse({
      feature: "support.draft",
      input: {
        feature: "support.draft",
        title: "T",
        body: "B",
        pattern_ids: [],
      },
    });
    expect(out).toEqual({ hit: false });
  });

  it("returns hit on a row with positive helpful balance and re-stamps provider as 'cache'", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "row-1",
          cached_response: {
            content: "Cached body",
            model_used: "claude-sonnet-4-6",
            provider_used: "anthropic",
            input_tokens: 100,
            output_tokens: 50,
          },
          model_used: "claude-sonnet-4-6",
          provider_used: "anthropic",
          hit_count: 3,
          helpful_count: 2,
          unhelpful_count: 0,
        },
      ],
    });
    mockWriteQuery.mockResolvedValueOnce({ rows: [{ id: "row-1" }] });

    const out = await lookupCachedResponse({
      feature: "support.draft",
      input: {
        feature: "support.draft",
        title: "T",
        body: "B",
        pattern_ids: [],
      },
    });

    expect(out).toMatchObject({
      hit: true,
      cache_id: "row-1",
    });
    if (out.hit) {
      expect(out.cached.content).toBe("Cached body");
      expect(out.cached.provider_used).toBe("cache");
      expect(out.cached.input_tokens).toBe(100);
      expect(out.cached.output_tokens).toBe(50);
    }
  });

  it("increments hit_count + tokens_saved + last_used_at on hit", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "row-2",
          cached_response: {
            content: "x",
            model_used: "m",
            provider_used: "p",
            input_tokens: 10,
            output_tokens: 5,
          },
          model_used: "m",
          provider_used: "p",
          hit_count: 0,
          helpful_count: 0,
          unhelpful_count: 0,
        },
      ],
    });
    mockWriteQuery.mockResolvedValueOnce({ rows: [{ id: "row-2" }] });

    await lookupCachedResponse({
      feature: "support.categorize",
      input: {
        feature: "support.categorize",
        title: "T",
        body: "B",
      },
    });

    expect(mockWriteQuery).toHaveBeenCalledTimes(1);
    const sql = mockWriteQuery.mock.calls[0][0] as string;
    const params = mockWriteQuery.mock.calls[0][1] as unknown[];
    expect(sql).toMatch(/UPDATE instinct_support_response_cache/);
    expect(sql).toMatch(/hit_count = hit_count \+ 1/);
    expect(sql).toMatch(/last_used_at = NOW\(\)/);
    expect(params).toEqual(["row-2", 15]);
  });

  it("fires the support.cache_hit analytics event on hit", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "row-3",
          cached_response: {
            content: "x",
            model_used: "m",
            provider_used: "p",
            input_tokens: 7,
            output_tokens: 3,
          },
          model_used: "m",
          provider_used: "p",
          hit_count: 0,
          helpful_count: 1,
          unhelpful_count: 0,
        },
      ],
    });
    mockWriteQuery.mockResolvedValueOnce({ rows: [{ id: "row-3" }] });

    await lookupCachedResponse({
      feature: "support.auto_ack",
      input: {
        feature: "support.auto_ack",
        title: "T",
        body: "B",
        pattern_id: "pat-x",
      },
    });

    expect(mockTrackEvent).toHaveBeenCalledWith(
      "support.cache_hit",
      "system",
      "system",
      expect.objectContaining({
        feature: "support.auto_ack",
        cache_id: "row-3",
        tokens_saved: 10,
      }),
    );
  });

  it("returns hit:false on DB query throw and records the error", async () => {
    mockQuery.mockRejectedValueOnce(new Error("connection refused"));
    const out = await lookupCachedResponse({
      feature: "support.draft",
      input: {
        feature: "support.draft",
        title: "T",
        body: "B",
        pattern_ids: [],
      },
    });
    expect(out).toEqual({ hit: false });
    expect(mockRecordError).toHaveBeenCalled();
  });

  it("filters out rows where unhelpful_count > helpful_count via the SQL clause", async () => {
    /* The quality gate is enforced via the WHERE clause `helpful_count
       >= unhelpful_count`. We assert it's present in the SQL — the
       database layer does the actual filtering, so a row that fails the
       gate just doesn't come back from query. */
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await lookupCachedResponse({
      feature: "support.draft",
      input: {
        feature: "support.draft",
        title: "T",
        body: "B",
        pattern_ids: [],
      },
    });
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toMatch(/helpful_count >= unhelpful_count/);
  });
});

/* ------------------------------------------------------------------ */
/* cacheResponse                                                        */
/* ------------------------------------------------------------------ */

describe("cacheResponse", () => {
  it("returns empty cache_id when DATABASE_URL is unset", async () => {
    delete process.env.DATABASE_URL;
    const out = await cacheResponse({
      feature: "support.draft",
      input: {
        feature: "support.draft",
        title: "T",
        body: "B",
        pattern_ids: [],
      },
      response: SAMPLE_AI_RESPONSE,
    });
    expect(out.cache_id).toBe("");
    expect(mockWriteQuery).not.toHaveBeenCalled();
  });

  it("inserts a new row on first call and returns the id", async () => {
    mockWriteQuery.mockResolvedValueOnce({ rows: [{ id: "new-1" }] });
    const out = await cacheResponse({
      feature: "support.draft",
      input: {
        feature: "support.draft",
        title: "T",
        body: "B",
        pattern_ids: ["a"],
      },
      response: SAMPLE_AI_RESPONSE,
    });
    expect(out.cache_id).toBe("new-1");
    const sql = mockWriteQuery.mock.calls[0][0] as string;
    expect(sql).toMatch(/INSERT INTO instinct_support_response_cache/);
    expect(sql).toMatch(/ON CONFLICT \(feature, lexical_signature\)/);
  });

  it("bumps the existing row instead of inserting when cache_id is provided", async () => {
    mockWriteQuery.mockResolvedValueOnce({ rows: [{ id: "existing-1" }] });
    const out = await cacheResponse({
      feature: "support.draft",
      input: {
        feature: "support.draft",
        title: "T",
        body: "B",
        pattern_ids: [],
      },
      response: SAMPLE_AI_RESPONSE,
      cache_id: "existing-1",
    });
    expect(out.cache_id).toBe("existing-1");
    const sql = mockWriteQuery.mock.calls[0][0] as string;
    expect(sql).toMatch(/UPDATE instinct_support_response_cache/);
    expect(sql).not.toMatch(/INSERT/);
  });

  it("returns empty cache_id and records error when writeQuery throws", async () => {
    mockWriteQuery.mockRejectedValueOnce(new Error("dup key"));
    const out = await cacheResponse({
      feature: "support.draft",
      input: {
        feature: "support.draft",
        title: "T",
        body: "B",
        pattern_ids: [],
      },
      response: SAMPLE_AI_RESPONSE,
    });
    expect(out.cache_id).toBe("");
    expect(mockRecordError).toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/* recordCacheFeedback                                                  */
/* ------------------------------------------------------------------ */

describe("recordCacheFeedback", () => {
  it("bumps helpful_count when helpful=true", async () => {
    mockWriteQuery.mockResolvedValueOnce({ rows: [{ id: "row-1" }] });
    await recordCacheFeedback("row-1", true);
    expect(mockWriteQuery).toHaveBeenCalledTimes(1);
    const sql = mockWriteQuery.mock.calls[0][0] as string;
    expect(sql).toMatch(/helpful_count = helpful_count \+ 1/);
  });

  it("bumps unhelpful_count when helpful=false", async () => {
    mockWriteQuery.mockResolvedValueOnce({ rows: [{ id: "row-1" }] });
    await recordCacheFeedback("row-1", false);
    expect(mockWriteQuery).toHaveBeenCalledTimes(1);
    const sql = mockWriteQuery.mock.calls[0][0] as string;
    expect(sql).toMatch(/unhelpful_count = unhelpful_count \+ 1/);
  });

  it("is a no-op when cache_id is empty", async () => {
    await recordCacheFeedback("", true);
    expect(mockWriteQuery).not.toHaveBeenCalled();
  });

  it("is a no-op when DATABASE_URL is unset", async () => {
    delete process.env.DATABASE_URL;
    await recordCacheFeedback("row-1", true);
    expect(mockWriteQuery).not.toHaveBeenCalled();
  });

  it("swallows DB errors via obs.recordError", async () => {
    mockWriteQuery.mockRejectedValueOnce(new Error("db down"));
    await expect(recordCacheFeedback("row-1", true)).resolves.toBeUndefined();
    expect(mockRecordError).toHaveBeenCalled();
  });
});
