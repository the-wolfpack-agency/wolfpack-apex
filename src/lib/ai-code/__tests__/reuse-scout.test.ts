/**
 * The reuse scout - the control that would have caught the functional-duplication
 * failure (writing getCostSummary when /api/insights/ai-cost already existed).
 */
const mockFetchTree = jest.fn();
jest.mock("@/lib/github-client", () => ({ fetchRepoTree: (...a: unknown[]) => mockFetchTree(...a) }));

import { extractIntentKeywords, scoreReuseCandidates, buildReuseBlock, findReuseCandidates } from "@/lib/ai-code/reuse-scout";

describe("extractIntentKeywords", () => {
  it("keeps significant domain words, drops stopwords + short + numbers", () => {
    const k = extractIntentKeywords("Add a model router price counter to the admin page that shows spend over 30 days");
    expect(k).toEqual(expect.arrayContaining(["model", "router", "price", "counter", "spend", "admin"]));
    expect(k).not.toContain("add");
    expect(k).not.toContain("the");
    expect(k).not.toContain("30");
    expect(k).not.toContain("page"); // stopword (structural)
  });
  it("singularizes crudely so plural matches singular", () => {
    expect(extractIntentKeywords("counters and totals")).toEqual(expect.arrayContaining(["counter", "total"]));
  });
});

const TREE = [
  "src/app/api/insights/ai-cost/route.ts",
  "src/lib/ai-code/cost.ts",
  "src/lib/ai/workspace-policy.ts",
  "src/app/(dashboard)/admin/ai-router/page.tsx",
  "src/lib/assistant/image-compress.ts",
  "src/components/Figure.tsx",
  "src/lib/ai-code/__tests__/cost.test.ts",
  "package-lock.json",
];

describe("scoreReuseCandidates (the anti-duplication core)", () => {
  it("surfaces the existing COST capability for a price/cost counter task", () => {
    const k = extractIntentKeywords("add a model router price cost counter showing spend");
    const hits = scoreReuseCandidates(k, TREE).map((c) => c.path);
    // the cost files rank in (via the cost<->price<->spend synonym map)
    expect(hits).toContain("src/app/api/insights/ai-cost/route.ts");
    expect(hits).toContain("src/lib/ai-code/cost.ts");
    // and NOT unrelated files or tests/lockfiles
    expect(hits).not.toContain("src/components/Figure.tsx");
    expect(hits).not.toContain("src/lib/ai-code/__tests__/cost.test.ts");
    expect(hits).not.toContain("package-lock.json");
  });
  it("weights a filename match over a directory match (ranking)", () => {
    const ranked = scoreReuseCandidates(["cost"], ["a/cost/x.ts", "b/cost-report.ts"]);
    // "cost-report.ts" (filename hit) outranks "x.ts" in a /cost/ dir
    expect(ranked[0].path).toBe("b/cost-report.ts");
  });
  it("a strong filename match qualifies on one concept, but a weak ancestor-only hit does not", () => {
    // filename literally "cost" -> strong, qualifies
    expect(scoreReuseCandidates(["cost"], ["src/lib/ai-code/cost.ts"]).map((c) => c.path)).toEqual(["src/lib/ai-code/cost.ts"]);
    // "cost" only as a deep ancestor dir, generic filename -> below the floor, excluded
    expect(scoreReuseCandidates(["cost"], ["src/cost/deep/nested/thing.ts"])).toEqual([]);
  });
  it("excludes paths the prompt already named (buildRepoContext covers those)", () => {
    const k = ["cost", "counter", "spend"];
    const out = scoreReuseCandidates(k, TREE, ["src/lib/ai-code/cost.ts"]).map((c) => c.path);
    expect(out).not.toContain("src/lib/ai-code/cost.ts");
  });
});

describe("buildReuseBlock", () => {
  it("is empty when nothing scored (never nags with noise)", () => {
    expect(buildReuseBlock([])).toBe("");
  });
  it("lists candidates and instructs reuse-or-extend", () => {
    const b = buildReuseBlock([{ path: "src/lib/x.ts", score: 6 }]);
    expect(b).toMatch(/REUSE CHECK/);
    expect(b).toMatch(/src\/lib\/x\.ts/);
    expect(b).toMatch(/REUSE or EXTEND/);
  });
});

describe("findReuseCandidates (best-effort orchestration)", () => {
  beforeEach(() => jest.clearAllMocks());
  it("fetches the tree once and returns a block for a matching task", async () => {
    mockFetchTree.mockResolvedValue(TREE);
    const r = await findReuseCandidates({ client: {} as never, repo: "o/r", prompt: "add a cost spend counter" });
    expect(mockFetchTree).toHaveBeenCalledTimes(1);
    expect(r.block).toMatch(/ai-cost\/route\.ts/);
  });
  it("never throws: a tree-fetch failure degrades to an empty block", async () => {
    mockFetchTree.mockRejectedValue(new Error("github down"));
    expect(await findReuseCandidates({ client: {} as never, repo: "o/r", prompt: "x" })).toEqual({ block: "", candidates: [], semantic: false });
  });
});

describe("precision: generic repo/structural terms do not create false duplicates", () => {
  // Found by the live client-build dogfood (3 common build types all held by the
  // DRY gate): two were false positives from generic terms coinciding.
  const scoreAgainst = (prompt: string, path: string): number =>
    scoreReuseCandidates(extractIntentKeywords(prompt), [path])[0]?.score ?? 0;

  it("a /ping health route is NOT flagged as duplicating check-credentials.ts", () => {
    // was 8 (check + auth->credential synonym); "check" is now a stopword.
    expect(
      scoreAgainst(
        "Create a new API route src/app/api/ping/route.ts: a public health check; add the // PUBLIC marker the auth-bypass scan expects.",
        "scripts/check-credentials.ts",
      ),
    ).toBeLessThan(8);
  });

  it("a new feedback-table migration is NOT flagged as duplicating an aliases migration", () => {
    // was 8 ("instinct" + "table", both generic repo/DB terms, now stopwords).
    expect(
      scoreAgainst(
        "Create a migration that adds an idempotent table instinct_client_feedback using CREATE TABLE IF NOT EXISTS.",
        "src/db/migrations/014_instinct_table_aliases.sql",
      ),
    ).toBeLessThan(8);
  });

  it("STILL flags a genuine duplicate: a new StatusPill vs an existing StatusPill", () => {
    // the legitimate catch must survive the precision tightening (status+pill=8).
    expect(
      scoreAgainst(
        "Create a React component src/components/StatusPill.tsx: a status pill.",
        "src/app/(dashboard)/support/_components/StatusPill.tsx",
      ),
    ).toBeGreaterThanOrEqual(8);
  });
});
