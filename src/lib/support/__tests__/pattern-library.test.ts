/**
 * pattern-library — unit tests.
 *
 * Covers:
 *   - findMatchingPatterns matches each of the 5 seed signatures
 *   - findMatchingPatterns no-match case returns []
 *   - findMatchingPatterns multi-match orders by net feedback
 *   - findMatchingPatterns ignores disabled rows + invalid regex
 *   - cacheKeyFor is order-independent on pattern_ids
 *   - generateDraftResponse: missing API key returns ok:false
 *   - generateDraftResponse: cache hit returns provider_used='cache' + tokens_used=0
 *   - generateDraftResponse: cache miss calls AI then writes to cache
 *   - generateDraftResponse: success path returns the model text
 *   - buildUserPrompt forwards diagnostic_text + pattern templates
 */

import type { SupportPattern } from "@/lib/support/types";
import { SEED_PATTERNS } from "@/lib/support/seed-patterns";

const mockComplete = jest.fn();
jest.mock("@/lib/ai", () => ({
  __esModule: true,
  getAIClient: () => ({ complete: mockComplete }),
}));

const mockLookupCachedResponse = jest.fn();
const mockCacheResponse = jest.fn();
jest.mock("@/lib/ai/response-cache", () => ({
  __esModule: true,
  lookupCachedResponse: (...args: unknown[]) => mockLookupCachedResponse(...args),
  cacheResponse: (...args: unknown[]) => mockCacheResponse(...args),
}));

import {
  findMatchingPatterns,
  generateDraftResponse,
  cacheKeyFor,
  buildUserPrompt,
  _resetDraftCacheForTests,
  isDraftGeneratorAvailable,
} from "@/lib/support/pattern-library";

function patternFromSeed(idx: number, overrides: Partial<SupportPattern> = {}): SupportPattern {
  const seed = SEED_PATTERNS[idx];
  return {
    id: `p-${idx}-${seed.slug}`,
    slug: seed.slug,
    name: seed.name,
    category: seed.category,
    match_signatures: [...seed.match_signatures],
    draft_template: seed.draft_template,
    success_count: 0,
    fail_count: 0,
    enabled: true,
    created_at: "2026-04-27T00:00:00.000Z",
    updated_at: "2026-04-27T00:00:00.000Z",
    ...overrides,
  };
}

const ALL_PATTERNS: SupportPattern[] = SEED_PATTERNS.map((_, i) => patternFromSeed(i));

beforeEach(() => {
  jest.clearAllMocks();
  _resetDraftCacheForTests();
  delete process.env.ANTHROPIC_API_KEY;
  /* Default cache mocks: every test gets a clean miss + a successful
     write unless the test overrides per-call. */
  mockLookupCachedResponse.mockResolvedValue({ hit: false });
  mockCacheResponse.mockResolvedValue({ cache_id: "new-cache-id" });
});

describe("findMatchingPatterns — each seed signature hits", () => {
  it("matches AADSTS20012", () => {
    const out = findMatchingPatterns(
      "User reports error AADSTS20012 on sign-in",
      ALL_PATTERNS,
    );
    expect(out.map((p) => p.slug)).toContain("aadsts20012-ws-fed");
  });

  it("matches WS-Federation alternate signature on the same pattern", () => {
    const out = findMatchingPatterns(
      "Browser shows: WS-Federation message could not be processed",
      ALL_PATTERNS,
    );
    expect(out.map((p) => p.slug)).toContain("aadsts20012-ws-fed");
  });

  it("matches AADSTS50126", () => {
    const out = findMatchingPatterns(
      "AADSTS50126: Invalid username or password",
      ALL_PATTERNS,
    );
    expect(out.map((p) => p.slug)).toContain("aadsts50126-bad-credentials");
  });

  it("matches AADSTS50034", () => {
    const out = findMatchingPatterns(
      "Got AADSTS50034 saying account does not exist",
      ALL_PATTERNS,
    );
    expect(out.map((p) => p.slug)).toContain("aadsts50034-account-not-found");
  });

  it("matches the Outlook license phrase", () => {
    const out = findMatchingPatterns(
      "Outlook says: your account doesn't have a license for Mail",
      ALL_PATTERNS,
    );
    expect(out.map((p) => p.slug)).toContain("outlook-license-missing");
  });

  it("matches the MFA lockout phrase", () => {
    const out = findMatchingPatterns(
      "User reports: MFA prevents lockout recovery — they can't sign in with the authenticator",
      ALL_PATTERNS,
    );
    expect(out.map((p) => p.slug)).toContain("mfa-locked-out");
  });
});

describe("findMatchingPatterns — edge cases", () => {
  it("returns [] for empty text", () => {
    expect(findMatchingPatterns("", ALL_PATTERNS)).toEqual([]);
  });

  it("returns [] when nothing matches", () => {
    const out = findMatchingPatterns(
      "User can't print to the office printer",
      ALL_PATTERNS,
    );
    expect(out).toEqual([]);
  });

  it("returns multiple matches and orders by net feedback (success - fail) desc", () => {
    const a = patternFromSeed(0, { id: "a", success_count: 0, fail_count: 5 });
    const b = patternFromSeed(0, { id: "b", success_count: 10, fail_count: 0 });
    const c = patternFromSeed(0, { id: "c", success_count: 3, fail_count: 1 });
    const out = findMatchingPatterns("Error AADSTS20012 hit", [a, b, c]);
    expect(out.map((p) => p.id)).toEqual(["b", "c", "a"]);
  });

  it("skips disabled patterns", () => {
    const disabled = patternFromSeed(0, { id: "off", enabled: false });
    const enabled = patternFromSeed(0, { id: "on", enabled: true });
    const out = findMatchingPatterns("AADSTS20012", [disabled, enabled]);
    expect(out.map((p) => p.id)).toEqual(["on"]);
  });

  it("ignores invalid regex signatures rather than throwing", () => {
    const broken = patternFromSeed(0, {
      id: "broken",
      match_signatures: [{ type: "regex", pattern: "(unclosed" }],
    });
    const out = findMatchingPatterns("anything", [broken]);
    expect(out).toEqual([]);
  });

  it("supports substring signatures (case sensitive + insensitive)", () => {
    const cs = patternFromSeed(0, {
      id: "cs",
      match_signatures: [{ type: "substring", pattern: "Boom" }],
    });
    const ci = patternFromSeed(0, {
      id: "ci",
      match_signatures: [
        { type: "substring", pattern: "BOOM", case_insensitive: true },
      ],
    });
    expect(findMatchingPatterns("a Boom day", [cs, ci]).map((p) => p.id)).toEqual([
      "cs",
      "ci",
    ]);
    expect(findMatchingPatterns("a boom day", [cs, ci]).map((p) => p.id)).toEqual([
      "ci",
    ]);
  });

  it("ticket body alone matches; multi-pattern ticket returns both", () => {
    const out = findMatchingPatterns(
      "User got AADSTS20012 and then later AADSTS50126 trying again",
      ALL_PATTERNS,
    );
    const slugs = out.map((p) => p.slug).sort();
    expect(slugs).toEqual([
      "aadsts20012-ws-fed",
      "aadsts50126-bad-credentials",
    ]);
  });
});

describe("cacheKeyFor", () => {
  it("returns the same key regardless of pattern id ordering", () => {
    const a = cacheKeyFor("body", ["b", "a", "c"]);
    const b = cacheKeyFor("body", ["a", "b", "c"]);
    expect(a).toBe(b);
  });

  it("returns different keys for different bodies", () => {
    expect(cacheKeyFor("x", ["a"])).not.toBe(cacheKeyFor("y", ["a"]));
  });
});

describe("buildUserPrompt", () => {
  it("includes title, body, diagnostic_text, and matched templates", () => {
    const ticket = {
      title: "User can't sign in",
      body: "AADSTS20012 on every browser",
      diagnostic_text: "Sign-in log id: 12345",
      created_by_email: "alicia@thewolfpack.agency",
    };
    const prompt = buildUserPrompt(ticket, [patternFromSeed(0)]);
    expect(prompt).toContain("User can't sign in");
    expect(prompt).toContain("AADSTS20012 on every browser");
    expect(prompt).toContain("Sign-in log id: 12345");
    expect(prompt).toContain("alicia@thewolfpack.agency");
    expect(prompt).toContain("aadsts20012-ws-fed");
  });

  it("falls back to a holding-reply hint when no patterns matched", () => {
    const ticket = {
      title: "T",
      body: "B",
      diagnostic_text: null,
      created_by_email: null,
    };
    const prompt = buildUserPrompt(ticket, []);
    expect(prompt).toContain("No patterns matched");
  });
});

describe("generateDraftResponse", () => {
  it("returns ok:false when ANTHROPIC_API_KEY is unset", async () => {
    expect(isDraftGeneratorAvailable()).toBe(false);
    const out = await generateDraftResponse({
      ticket: {
        title: "t",
        body: "b",
        diagnostic_text: null,
        created_by_email: null,
      },
      matchingPatterns: [patternFromSeed(0)],
    });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error_detail).toMatch(/ANTHROPIC_API_KEY/);
      expect(out.pattern_ids).toEqual([patternFromSeed(0).id]);
    }
  });

  it("calls the AI client and returns the joined text on success", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    mockComplete.mockResolvedValueOnce({
      content: "Hi Alicia,\n\nTry incognito.\n\nThe Wolfpack Team",
      model_used: "claude-sonnet-4-6",
      provider_used: "anthropic",
      input_tokens: 100,
      output_tokens: 50,
      cost_usd: 0.001,
      latency_ms: 5,
    });
    const out = await generateDraftResponse({
      ticket: {
        title: "Sign-in",
        body: "AADSTS20012",
        diagnostic_text: null,
        created_by_email: "alicia@thewolfpack.agency",
      },
      matchingPatterns: [patternFromSeed(0)],
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.draft).toContain("The Wolfpack Team");
      expect(out.from_cache).toBe(false);
      expect(out.tokens_used).toBe(150);
    }
    expect(mockComplete).toHaveBeenCalledTimes(1);
    expect(mockComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        model_tier: "standard",
        sensitivity: "public",
        metadata: expect.objectContaining({ feature: "support.draft" }),
      }),
    );
  });

  it("returns provider_used='cache' and DOES NOT call AI when the response cache hits", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    mockLookupCachedResponse.mockResolvedValueOnce({
      hit: true,
      cache_id: "cached-row-1",
      cached: {
        content: "Cached draft body",
        model_used: "claude-sonnet-4-6",
        provider_used: "cache",
        input_tokens: 100,
        output_tokens: 50,
        cost_usd: 0,
        latency_ms: 0,
      },
    });
    const out = await generateDraftResponse({
      ticket: {
        title: "t",
        body: "AADSTS50126 example body",
        diagnostic_text: null,
        created_by_email: null,
      },
      matchingPatterns: [patternFromSeed(1)],
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.draft).toBe("Cached draft body");
      expect(out.from_cache).toBe(true);
      expect(out.tokens_used).toBe(0);
      expect(out.cache_id).toBe("cached-row-1");
      expect(out.provider_used).toBe("cache");
    }
    /* The whole point: AI is NOT called on a cache hit. */
    expect(mockComplete).not.toHaveBeenCalled();
    expect(mockCacheResponse).not.toHaveBeenCalled();
  });

  it("calls AI on a cache miss and writes the result to the cache", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    mockLookupCachedResponse.mockResolvedValueOnce({ hit: false });
    mockComplete.mockResolvedValueOnce({
      content: "Fresh draft",
      model_used: "claude-sonnet-4-6",
      provider_used: "anthropic",
      input_tokens: 100,
      output_tokens: 50,
      cost_usd: 0.001,
      latency_ms: 5,
    });
    mockCacheResponse.mockResolvedValueOnce({ cache_id: "fresh-row-1" });

    const out = await generateDraftResponse({
      ticket: {
        title: "t",
        body: "fresh body",
        diagnostic_text: null,
        created_by_email: null,
      },
      matchingPatterns: [patternFromSeed(1)],
    });

    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.draft).toBe("Fresh draft");
      expect(out.from_cache).toBe(false);
      expect(out.tokens_used).toBe(150);
      expect(out.cache_id).toBe("fresh-row-1");
      expect(out.provider_used).toBe("anthropic");
    }
    expect(mockComplete).toHaveBeenCalledTimes(1);
    expect(mockCacheResponse).toHaveBeenCalledTimes(1);
    /* The cache write must include the cleaned (trimmed) text. */
    const cacheArgs = mockCacheResponse.mock.calls[0][0];
    expect(cacheArgs.feature).toBe("support.draft");
    expect(cacheArgs.response.content).toBe("Fresh draft");
  });

  it("returns ok:false when the AI client returns empty text", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    mockComplete.mockResolvedValueOnce({
      content: "",
      model_used: "claude-sonnet-4-6",
      provider_used: "anthropic",
      input_tokens: 1,
      output_tokens: 0,
      cost_usd: 0,
      latency_ms: 1,
    });
    const out = await generateDraftResponse({
      ticket: {
        title: "t",
        body: "no-text-blocks",
        diagnostic_text: null,
        created_by_email: null,
      },
      matchingPatterns: [],
    });
    expect(out.ok).toBe(false);
  });

  it("handles AI client exceptions cleanly", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    mockComplete.mockRejectedValueOnce(new Error("network blew up"));
    const out = await generateDraftResponse({
      ticket: {
        title: "t",
        body: "exception body",
        diagnostic_text: null,
        created_by_email: null,
      },
      matchingPatterns: [],
    });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error_detail).toMatch(/network blew up|unknown_error/);
    }
  });
});
