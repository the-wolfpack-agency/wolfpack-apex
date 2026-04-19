/**
 * Unit tests for the brief-edit learning-loop aggregator.
 *
 * Strategy: stub safeQuery to return fixture rows; assert the shape +
 * values of the returned BriefEditInsights. The aggregate function is
 * also exported pure so most tests bypass the DB layer entirely.
 */

const mockSafeQuery = jest.fn();
jest.mock("@/lib/db", () => ({
  safeQuery: (...args: unknown[]) => mockSafeQuery(...args),
}));

import {
  aggregateInsights,
  computeBriefEditInsights,
  extractSectionIndex,
  percentile,
  tokenizeInstruction,
  writeInsightsSnapshot,
  type BriefEditRow,
} from "@/lib/brief-edit-learning";

const WINDOW = {
  start: new Date("2026-04-01T00:00:00Z"),
  end: new Date("2026-04-08T00:00:00Z"),
};

function row(partial: Partial<BriefEditRow>): BriefEditRow {
  return {
    id: partial.id ?? "brief_edit_x",
    user_id: partial.user_id ?? "u_1",
    user_role: partial.user_role ?? "sales",
    instruction: partial.instruction ?? "",
    patch: partial.patch ?? [],
    accepted: partial.accepted ?? null,
    rejection_reason: partial.rejection_reason ?? null,
    latency_ms: partial.latency_ms ?? null,
    tokens_in: partial.tokens_in ?? null,
    tokens_out: partial.tokens_out ?? null,
    cost_usd: partial.cost_usd ?? null,
    model: partial.model ?? null,
    created_at: partial.created_at ?? "2026-04-02T12:00:00Z",
  };
}

describe("tokenizeInstruction", () => {
  it("lowercases + splits on punctuation + drops stopwords", () => {
    const tokens = tokenizeInstruction(
      "Please make the HERO Headline 'Season One' — and add a callout!",
    );
    expect(tokens).toContain("hero");
    expect(tokens).toContain("headline");
    expect(tokens).toContain("season");
    expect(tokens).toContain("one");
    expect(tokens).toContain("callout");
    // Stopwords / too-short must be filtered
    expect(tokens).not.toContain("the");
    expect(tokens).not.toContain("a");
    expect(tokens).not.toContain("and");
    expect(tokens).not.toContain("please");
  });

  it("returns [] for empty / whitespace input", () => {
    expect(tokenizeInstruction("")).toEqual([]);
    expect(tokenizeInstruction("   ")).toEqual([]);
  });

  it("does not emit numbers or punctuation as tokens", () => {
    const tokens = tokenizeInstruction("Set it to 3 columns, 100% wide.");
    for (const t of tokens) {
      expect(t).toMatch(/^[a-z]+$/);
    }
  });
});

describe("extractSectionIndex", () => {
  it("parses section index from a nested path", () => {
    expect(extractSectionIndex("/pages/0/sections/2/heading")).toBe(2);
    expect(extractSectionIndex("/pages/1/sections/0/body")).toBe(0);
    expect(extractSectionIndex("/pages/0/sections/7")).toBe(7);
  });
  it("returns null for non-section paths", () => {
    expect(extractSectionIndex("/client_slug")).toBeNull();
    expect(extractSectionIndex("/pages/0/title")).toBeNull();
    expect(extractSectionIndex(undefined)).toBeNull();
    expect(extractSectionIndex("")).toBeNull();
  });
});

describe("percentile", () => {
  it("nearest-rank percentiles match the spec fixture [10,20,30,40,1000]", () => {
    const values = [10, 20, 30, 40, 1000];
    // Nearest-rank with N=5: p50 => idx ceil(0.5*5)-1 = 2 → 30
    // p95 => ceil(0.95*5)-1 = 4 → 1000
    // p99 => ceil(0.99*5)-1 = 4 → 1000
    expect(percentile(values, 0.5)).toBe(30);
    expect(percentile(values, 0.95)).toBe(1000);
    expect(percentile(values, 0.99)).toBe(1000);
  });
  it("returns 0 on empty input", () => {
    expect(percentile([], 0.5)).toBe(0);
    expect(percentile([], 0.99)).toBe(0);
  });
  it("handles a single-element array", () => {
    expect(percentile([42], 0.5)).toBe(42);
    expect(percentile([42], 0.99)).toBe(42);
  });
});

describe("aggregateInsights — empty input", () => {
  it("returns zeros + valid shape with no NaN", () => {
    const insights = aggregateInsights([], WINDOW);
    expect(insights.window.rowCount).toBe(0);
    expect(insights.acceptanceRate.overall).toBe(0);
    expect(insights.acceptanceRate.byUser).toEqual({});
    expect(insights.acceptanceRate.byModel).toEqual({});
    expect(insights.rejectionReasons).toEqual([]);
    expect(insights.blockedPaths).toEqual([]);
    expect(insights.performance.latencyMs.p50).toBe(0);
    expect(insights.performance.latencyMs.p95).toBe(0);
    expect(insights.performance.latencyMs.p99).toBe(0);
    expect(insights.performance.tokens.meanIn).toBe(0);
    expect(insights.performance.tokens.meanOut).toBe(0);
    expect(insights.performance.totalCostUsd).toBe(0);
    expect(insights.sectionTypeEdits).toEqual([]);
    expect(insights.instructionThemes).toEqual([]);
    // No NaN anywhere.
    expect(Number.isNaN(insights.acceptanceRate.overall)).toBe(false);
    expect(Number.isNaN(insights.performance.tokens.meanIn)).toBe(false);
  });
});

describe("aggregateInsights — acceptance rate", () => {
  it("handles mix of accepted=true/false/NULL and per-user + per-model breakdown", () => {
    const rows: BriefEditRow[] = [
      row({ user_id: "u_a", model: "haiku", accepted: true }),
      row({ user_id: "u_a", model: "haiku", accepted: true }),
      row({ user_id: "u_a", model: "haiku", accepted: false }),
      row({ user_id: "u_b", model: "haiku", accepted: true }),
      row({ user_id: "u_b", model: "sonnet", accepted: false }),
      // undecided — excluded from denominator
      row({ user_id: "u_b", model: "sonnet", accepted: null }),
    ];
    const insights = aggregateInsights(rows, WINDOW);
    // overall: 3 accepted / 5 decided = 0.6
    expect(insights.acceptanceRate.overall).toBeCloseTo(0.6, 5);
    // u_a: 2/3, u_b: 1/2
    expect(insights.acceptanceRate.byUser["u_a"]).toBeCloseTo(2 / 3, 5);
    expect(insights.acceptanceRate.byUser["u_b"]).toBeCloseTo(1 / 2, 5);
    // haiku: 3/4 decided accepted. sonnet: 0/1.
    expect(insights.acceptanceRate.byModel["haiku"]).toBeCloseTo(3 / 4, 5);
    expect(insights.acceptanceRate.byModel["sonnet"]).toBe(0);
  });

  it("overall=0 when no rows have been decided (all NULL)", () => {
    const rows = [
      row({ accepted: null }),
      row({ accepted: null }),
    ];
    const insights = aggregateInsights(rows, WINDOW);
    expect(insights.acceptanceRate.overall).toBe(0);
    expect(insights.acceptanceRate.byUser).toEqual({});
  });
});

describe("aggregateInsights — rejection reasons", () => {
  it("buckets reasons and sorts by count desc", () => {
    const rows = [
      row({ accepted: false, rejection_reason: "patch_blocked" }),
      row({ accepted: false, rejection_reason: "patch_blocked" }),
      row({ accepted: false, rejection_reason: "user_rejected" }),
      row({ accepted: false, rejection_reason: "wrong tone" }),
      // accepted=true rows must not contribute
      row({ accepted: true }),
    ];
    const insights = aggregateInsights(rows, WINDOW);
    expect(insights.rejectionReasons).toEqual([
      { reason: "patch_blocked", count: 2 },
      { reason: "user_rejected", count: 1 },
      { reason: "wrong tone", count: 1 },
    ]);
  });
});

describe("aggregateInsights — blocked paths", () => {
  it("extracts /client_slug and other paths from patch_blocked rows", () => {
    const rows = [
      row({
        accepted: false,
        rejection_reason: "patch_blocked",
        patch: [
          { op: "replace", path: "/client_slug", value: "oops" },
          { op: "replace", path: "/pages/0/sections/0/heading", value: "ok" },
        ],
      }),
      row({
        accepted: false,
        rejection_reason: "patch_blocked",
        patch: [{ op: "replace", path: "/client_slug", value: "still-oops" }],
      }),
      row({
        accepted: false,
        rejection_reason: "patch_blocked",
        // JSONB returns strings sometimes — aggregator must parse them.
        patch: JSON.stringify([
          { op: "replace", path: "/github_repo", value: "other" },
        ]),
      }),
      // Non-blocked row with the same path must NOT contribute.
      row({
        accepted: true,
        patch: [{ op: "replace", path: "/client_slug", value: "ignored" }],
      }),
    ];
    const insights = aggregateInsights(rows, WINDOW);
    const paths = new Map(
      insights.blockedPaths.map((b) => [b.path, b.count]),
    );
    expect(paths.get("/client_slug")).toBe(2);
    expect(paths.get("/pages/0/sections/0/heading")).toBe(1);
    expect(paths.get("/github_repo")).toBe(1);
    // Sorted desc by count.
    expect(insights.blockedPaths[0].count).toBeGreaterThanOrEqual(
      insights.blockedPaths[insights.blockedPaths.length - 1].count,
    );
  });
});

describe("aggregateInsights — performance percentiles", () => {
  it("p50/p95/p99 over [10,20,30,40,1000] match nearest-rank", () => {
    const rows = [10, 20, 30, 40, 1000].map((ms) =>
      row({
        latency_ms: ms,
        tokens_in: 100,
        tokens_out: 40,
        cost_usd: "0.000500",
      }),
    );
    const insights = aggregateInsights(rows, WINDOW);
    expect(insights.performance.latencyMs.p50).toBe(30);
    expect(insights.performance.latencyMs.p95).toBe(1000);
    expect(insights.performance.latencyMs.p99).toBe(1000);
    expect(insights.performance.tokens.meanIn).toBe(100);
    expect(insights.performance.tokens.meanOut).toBe(40);
    // 5 * 0.000500 = 0.0025
    expect(insights.performance.totalCostUsd).toBeCloseTo(0.0025, 6);
  });

  it("ignores null latency / tokens entries when computing means", () => {
    const rows = [
      row({ latency_ms: 100, tokens_in: 10, tokens_out: 5, cost_usd: null }),
      row({ latency_ms: null, tokens_in: null, tokens_out: null }),
    ];
    const insights = aggregateInsights(rows, WINDOW);
    expect(insights.performance.tokens.meanIn).toBe(10);
    expect(insights.performance.tokens.meanOut).toBe(5);
    expect(insights.performance.latencyMs.p50).toBe(100);
    expect(insights.performance.totalCostUsd).toBe(0);
  });
});

describe("aggregateInsights — section edits", () => {
  it("counts distinct section indexes per patch (MVP: by index, not type)", () => {
    const rows = [
      row({
        // Two ops on section 2 -> one touch of section 2.
        patch: [
          { op: "replace", path: "/pages/0/sections/2/heading", value: "h" },
          { op: "replace", path: "/pages/0/sections/2/body", value: "b" },
        ],
      }),
      row({
        patch: [
          { op: "replace", path: "/pages/0/sections/0/heading", value: "x" },
          { op: "replace", path: "/pages/0/sections/2/body", value: "y" },
        ],
      }),
      row({
        // Non-section edit — ignored.
        patch: [{ op: "replace", path: "/product/name", value: "New" }],
      }),
    ];
    const insights = aggregateInsights(rows, WINDOW);
    const byKey = new Map(
      insights.sectionTypeEdits.map((s) => [s.sectionType, s.count]),
    );
    expect(byKey.get("section_2")).toBe(2);
    expect(byKey.get("section_0")).toBe(1);
    // Sorted desc.
    expect(insights.sectionTypeEdits[0].sectionType).toBe("section_2");
  });
});

describe("aggregateInsights — instruction themes", () => {
  it("counts distinct non-stopword terms across instructions (<= 50)", () => {
    const rows = [
      row({ instruction: "Make the hero headline larger." }),
      row({ instruction: "Change hero headline to Season One" }),
      row({ instruction: "Add a callout about the season." }),
    ];
    const insights = aggregateInsights(rows, WINDOW);
    const byTerm = new Map(
      insights.instructionThemes.map((t) => [t.term, t.count]),
    );
    // "hero" appears in 2 instructions -> count 2
    expect(byTerm.get("hero")).toBe(2);
    expect(byTerm.get("headline")).toBe(2);
    expect(byTerm.get("season")).toBe(2);
    expect(byTerm.get("callout")).toBe(1);
    // Stopwords gone.
    expect(byTerm.has("the")).toBe(false);
    expect(byTerm.has("a")).toBe(false);
    // Cap at 50 entries.
    expect(insights.instructionThemes.length).toBeLessThanOrEqual(50);
  });
});

describe("aggregateInsights — window echo", () => {
  it("reflects the caller-supplied window regardless of row content", () => {
    const insights = aggregateInsights([], WINDOW);
    expect(insights.window.start).toBe(WINDOW.start.toISOString());
    expect(insights.window.end).toBe(WINDOW.end.toISOString());
    expect(insights.window.rowCount).toBe(0);
  });
});

describe("computeBriefEditInsights — DB layer", () => {
  beforeEach(() => jest.clearAllMocks());

  it("passes a parameterised window to safeQuery and aggregates its rows", async () => {
    const now = new Date("2026-04-08T00:00:00Z");
    const rows = [
      row({ accepted: true, latency_ms: 100 }),
      row({ accepted: false, rejection_reason: "user_rejected" }),
    ];
    mockSafeQuery.mockResolvedValueOnce({ rows, fromCache: false });

    const insights = await computeBriefEditInsights({ days: 7, now });

    expect(mockSafeQuery).toHaveBeenCalledTimes(1);
    const call = mockSafeQuery.mock.calls[0];
    const [sql, params] = call;
    expect(String(sql)).toMatch(/apex_site_brief_edits/);
    expect(params[0]).toBe(new Date(now.getTime() - 7 * 864e5).toISOString());
    expect(params[1]).toBe(now.toISOString());

    expect(insights.window.rowCount).toBe(2);
    expect(insights.acceptanceRate.overall).toBe(0.5);
  });

  it("clamps non-positive days to 1", async () => {
    const now = new Date("2026-04-08T00:00:00Z");
    mockSafeQuery.mockResolvedValueOnce({ rows: [], fromCache: false });
    await computeBriefEditInsights({ days: 0, now });
    const [, params] = mockSafeQuery.mock.calls[0];
    // 1 day window, not 0.
    expect(params[0]).toBe(new Date(now.getTime() - 864e5).toISOString());
  });

  it("shadow mode: empty rows yield empty-but-valid insights", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [], fromCache: true });
    const insights = await computeBriefEditInsights({ days: 7 });
    expect(insights.window.rowCount).toBe(0);
    expect(insights.acceptanceRate.overall).toBe(0);
    expect(insights.instructionThemes).toEqual([]);
  });
});

describe("writeInsightsSnapshot", () => {
  beforeEach(() => jest.clearAllMocks());

  it("INSERTs into instinct_brief_edit_insights_snapshots with JSON payload (migration 055 canonical name)", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [], fromCache: false });
    const insights = aggregateInsights([], WINDOW);
    const id = await writeInsightsSnapshot(insights);

    expect(id).toMatch(/^brief_edit_insights_/);
    expect(mockSafeQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockSafeQuery.mock.calls[0];
    // Post-055 canonical name. A backward-compat view with the old
    // apex_* name still exists in the DB, but new code always writes
    // to the canonical instinct_* name so tests must track that.
    expect(String(sql)).toMatch(/instinct_brief_edit_insights_snapshots/);
    // Must NOT regress to the old name at the code layer.
    expect(String(sql)).not.toMatch(/apex_brief_edit_insights_snapshots/);
    expect(params[0]).toBe(id);
    expect(params[1]).toBe(WINDOW.start.toISOString());
    expect(params[2]).toBe(WINDOW.end.toISOString());
    // payload must be JSON-serialised so JSONB column can store it.
    const parsed = JSON.parse(params[3] as string);
    expect(parsed.window.rowCount).toBe(0);
  });
});
