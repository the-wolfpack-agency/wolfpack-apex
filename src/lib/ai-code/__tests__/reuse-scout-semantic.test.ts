/**
 * Semantic reuse widening: pure helpers + the non-throwing widener with an
 * injected fake embedder. Covers the "new name, same purpose" win AND every
 * graceful-fallback path (flag off, no embedder, too few vectors, embed throws).
 */
import {
  semanticReuseEnabled,
  humanizePath,
  cosine,
  prescorePaths,
  rankBySemantic,
  mergeReuseCandidates,
  widenReuseWithSemantics,
  MAX_EMBED_DOCS,
  type EmbedFn,
} from "@/lib/ai-code/reuse-scout-semantic";
import type { ReuseCandidate } from "@/lib/ai-code/reuse-scout";

describe("semanticReuseEnabled", () => {
  test("off by default; on only for truthy flag values", () => {
    expect(semanticReuseEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(semanticReuseEnabled({ AI_CODE_SEMANTIC_REUSE: "off" } as unknown as NodeJS.ProcessEnv)).toBe(false);
    expect(semanticReuseEnabled({ AI_CODE_SEMANTIC_REUSE: "on" } as unknown as NodeJS.ProcessEnv)).toBe(true);
    expect(semanticReuseEnabled({ AI_CODE_SEMANTIC_REUSE: "TRUE" } as unknown as NodeJS.ProcessEnv)).toBe(true);
    expect(semanticReuseEnabled({ AI_CODE_SEMANTIC_REUSE: "1" } as unknown as NodeJS.ProcessEnv)).toBe(true);
  });
});

describe("humanizePath", () => {
  test("splits separators + camelCase, drops extension, lowercases", () => {
    expect(humanizePath("src/lib/cost-summary.ts")).toBe("src lib cost summary");
    expect(humanizePath("src/lib/costSummary.tsx")).toBe("src lib cost summary");
    expect(humanizePath("src/app/api/pr_gate/route.ts")).toBe("src app api pr gate route");
  });
});

describe("cosine", () => {
  test("1 for identical direction, 0 for orthogonal, 0 on degeneracy", () => {
    expect(cosine([1, 0], [2, 0])).toBeCloseTo(1, 5);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0, 5);
    expect(cosine([0, 0], [1, 1])).toBe(0);
    expect(cosine([1, 2, 3], [1, 2])).toBe(0); // length mismatch
    expect(cosine([], [])).toBe(0);
  });
});

describe("prescorePaths", () => {
  const tree = [
    "src/lib/cost-summary.ts",
    "src/lib/billing/spend-tracker.ts",
    "src/components/Button.tsx",
    "src/lib/__tests__/cost-summary.test.ts", // excluded: test file
    "README.md", // excluded: not a code file
  ];
  test("keeps code files only, ranks by keyword overlap, bounds the count", () => {
    const ranked = prescorePaths(["cost", "spend"], tree);
    expect(ranked).toContain("src/lib/cost-summary.ts");
    expect(ranked).toContain("src/lib/billing/spend-tracker.ts");
    expect(ranked).not.toContain("src/lib/__tests__/cost-summary.test.ts");
    expect(ranked).not.toContain("README.md");
    // cost-summary matches "cost"; spend-tracker matches "spend" - both score 1,
    // Button matches neither (score 0) and sorts last.
    expect(ranked[ranked.length - 1]).toBe("src/components/Button.tsx");
  });
  test("honours the explicit exclude list and the limit", () => {
    const ranked = prescorePaths(["cost"], tree, ["src/lib/cost-summary.ts"], 1);
    expect(ranked).not.toContain("src/lib/cost-summary.ts");
    expect(ranked.length).toBe(1);
  });
  test("never embeds more than MAX_EMBED_DOCS", () => {
    const big = Array.from({ length: MAX_EMBED_DOCS + 50 }, (_, i) => `src/lib/mod-${i}.ts`);
    expect(prescorePaths(["mod"], big).length).toBe(MAX_EMBED_DOCS);
  });
});

describe("rankBySemantic", () => {
  test("keeps candidates at/above the threshold, highest cosine first", () => {
    const prompt = [1, 0];
    const paths = ["a.ts", "b.ts", "c.ts"];
    const vecs = [[1, 0], [0.9, 0.1], [0, 1]]; // c is orthogonal -> dropped
    const ranked = rankBySemantic(prompt, paths, vecs, 0.5, 5);
    expect(ranked.map((r) => r.path)).toEqual(["a.ts", "b.ts"]);
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
  });
  test("skips missing/empty doc vectors without throwing", () => {
    const ranked = rankBySemantic([1, 0], ["a.ts", "b.ts"], [[], [1, 0]], 0.5);
    expect(ranked.map((r) => r.path)).toEqual(["b.ts"]);
  });
});

describe("mergeReuseCandidates", () => {
  const kw: ReuseCandidate[] = [{ path: "k1.ts", score: 8 }, { path: "k2.ts", score: 4 }];
  const sem: ReuseCandidate[] = [{ path: "k2.ts", score: 0.9 }, { path: "s1.ts", score: 0.8 }];
  test("keyword first + wins collisions; semantic-only appended; capped", () => {
    const merged = mergeReuseCandidates(kw, sem, 8);
    expect(merged.map((c) => c.path)).toEqual(["k1.ts", "k2.ts", "s1.ts"]);
    // k2 keeps its integer keyword score, not the cosine.
    expect(merged.find((c) => c.path === "k2.ts")!.score).toBe(4);
  });
  test("respects topN", () => {
    expect(mergeReuseCandidates(kw, sem, 2).map((c) => c.path)).toEqual(["k1.ts", "k2.ts"]);
  });
});

describe("widenReuseWithSemantics", () => {
  const tree = ["src/lib/cost-summary.ts", "src/lib/unrelated-widget.ts", "src/components/Button.tsx"];
  const keywordCandidates: ReuseCandidate[] = []; // keyword gate found nothing (synonym miss)

  test("surfaces a synonym match the keyword gate missed", async () => {
    // Fake embedder: prompt ("spending") and cost-summary share a direction;
    // the others are orthogonal.
    const embed: EmbedFn = async (texts) =>
      texts.map((t) => (/cost|spend/.test(t) ? [1, 0] : [0, 1]));
    const out = await widenReuseWithSemantics({
      embed,
      prompt: "add a spending tracker",
      keywords: ["spending", "tracker"],
      treePaths: tree,
      keywordCandidates,
    });
    expect(out.map((c) => c.path)).toContain("src/lib/cost-summary.ts");
    expect(out.map((c) => c.path)).not.toContain("src/components/Button.tsx");
  });

  test("keyword candidates are preserved and lead the result", async () => {
    const kw: ReuseCandidate[] = [{ path: "src/lib/known.ts", score: 7 }];
    const embed: EmbedFn = async (texts) => texts.map(() => [1, 0]);
    const out = await widenReuseWithSemantics({
      embed, prompt: "x", keywords: ["x"], treePaths: tree, keywordCandidates: kw,
    });
    expect(out[0]).toEqual({ path: "src/lib/known.ts", score: 7 });
  });

  test("falls back to keyword-only when embedder returns too few vectors", async () => {
    const kw: ReuseCandidate[] = [{ path: "k.ts", score: 5 }];
    const embed: EmbedFn = async () => []; // e.g. 429 -> [] (never throws)
    const out = await widenReuseWithSemantics({
      embed, prompt: "spending", keywords: ["spending"], treePaths: tree, keywordCandidates: kw,
    });
    expect(out).toEqual(kw);
  });

  test("falls back to keyword-only when the embedder throws", async () => {
    const kw: ReuseCandidate[] = [{ path: "k.ts", score: 5 }];
    const embed: EmbedFn = async () => { throw new Error("boom"); };
    const out = await widenReuseWithSemantics({
      embed, prompt: "spending", keywords: ["spending"], treePaths: tree, keywordCandidates: kw,
    });
    expect(out).toEqual(kw);
  });

  test("returns keyword-only when there are no embeddable paths", async () => {
    const kw: ReuseCandidate[] = [{ path: "only.ts", score: 5 }];
    const embed = jest.fn<Promise<number[][]>, [string[]]>();
    const out = await widenReuseWithSemantics({
      embed, prompt: "x", keywords: ["x"], treePaths: [], keywordCandidates: kw,
    });
    expect(out).toEqual(kw);
    expect(embed).not.toHaveBeenCalled(); // no wasted embed call
  });
});
