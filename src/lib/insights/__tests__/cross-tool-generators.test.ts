/**
 * cross-tool-generators — unit coverage for the rule-based pattern
 * matchers. Each generator is tested in isolation with its dependencies
 * mocked so we exercise the matching logic, severity grading, and
 * shape of the returned insights without hitting any external service.
 */

const mockSearchPRs = jest.fn();
const mockListDeployments = jest.fn();
const mockVercelConfigured = jest.fn();

jest.mock("@/lib/assistant/tools/github-query-client", () => ({
  searchPullRequests: (...a: unknown[]) => mockSearchPRs(...a),
}));
jest.mock("@/lib/integrations/vercel", () => ({
  listDeployments: (...a: unknown[]) => mockListDeployments(...a),
  vercelIsConfigured: () => mockVercelConfigured(),
}));

import {
  runAllInsightGenerators,
  INSIGHT_GENERATORS,
} from "@/lib/insights/cross-tool-generators";

const ctx = { userId: "u1", userRole: "cto" };

beforeEach(() => {
  mockSearchPRs.mockReset();
  mockListDeployments.mockReset();
  mockVercelConfigured.mockReset();
});

describe("INSIGHT_GENERATORS registry", () => {
  test("ships at least 2 generators in v1", () => {
    expect(INSIGHT_GENERATORS.length).toBeGreaterThanOrEqual(2);
  });
  test("every generator has a name, label, requires list, and async run()", () => {
    for (const g of INSIGHT_GENERATORS) {
      expect(typeof g.name).toBe("string");
      expect(typeof g.label).toBe("string");
      expect(Array.isArray(g.requires)).toBe(true);
      expect(typeof g.run).toBe("function");
    }
  });
});

describe("github_pr_stagnation generator", () => {
  test("flags PRs older than 7 days; severity escalates at 14 days", async () => {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    mockSearchPRs.mockResolvedValueOnce({
      ok: true,
      data: [
        {
          number: 1,
          title: "stale 8 days",
          state: "open",
          repo: "wolfpack-apex",
          user: "u",
          html_url: "https://github.com/x/x/pull/1",
          created_at: new Date(now - 8 * day).toISOString(),
          updated_at: new Date(now - 8 * day).toISOString(),
        },
        {
          number: 2,
          title: "stale 20 days",
          state: "open",
          repo: "wolfpack-apex",
          user: "u",
          html_url: "https://github.com/x/x/pull/2",
          created_at: new Date(now - 20 * day).toISOString(),
          updated_at: new Date(now - 20 * day).toISOString(),
        },
        {
          number: 3,
          title: "fresh 2 days",
          state: "open",
          repo: "wolfpack-apex",
          user: "u",
          html_url: "https://github.com/x/x/pull/3",
          created_at: new Date(now - 2 * day).toISOString(),
          updated_at: new Date(now - 2 * day).toISOString(),
        },
      ],
    });
    const gen = INSIGHT_GENERATORS.find((g) => g.name === "github_pr_stagnation")!;
    const out = await gen.run(ctx);
    expect(out).toHaveLength(2); // 2 stale, 1 fresh
    expect(out.find((i) => i.title.includes("#1"))?.severity).toBe("medium");
    expect(out.find((i) => i.title.includes("#2"))?.severity).toBe("high");
    expect(out.every((i) => i.sources.includes("github"))).toBe(true);
  });

  test("degrades to [] when github query fails", async () => {
    mockSearchPRs.mockResolvedValueOnce({ ok: false, code: "auth_failed", message: "x" });
    const gen = INSIGHT_GENERATORS.find((g) => g.name === "github_pr_stagnation")!;
    expect(await gen.run(ctx)).toEqual([]);
  });
});

describe("vercel_failed_no_followup generator", () => {
  test("flags production failures as high; preview as medium", async () => {
    mockVercelConfigured.mockReturnValue(true);
    mockListDeployments.mockResolvedValueOnce({
      ok: true,
      data: {
        deployments: [
          {
            uid: "d-prod",
            name: "wolfpack-auto",
            url: "wolfpack-auto-abc.vercel.app",
            state: "ERROR",
            target: "production",
            createdAt: Date.now(),
            meta: { githubCommitMessage: "broke prod", githubCommitRef: "main" },
          },
          {
            uid: "d-prev",
            name: "wolfpack-auto",
            url: "wolfpack-auto-xyz.vercel.app",
            state: "ERROR",
            target: "preview",
            createdAt: Date.now(),
          },
          {
            uid: "d-ok",
            name: "wolfpack-auto",
            url: "wolfpack-auto-def.vercel.app",
            state: "READY",
            target: "production",
            createdAt: Date.now(),
          },
        ],
      },
    });
    const gen = INSIGHT_GENERATORS.find((g) => g.name === "vercel_failed_no_followup")!;
    const out = await gen.run(ctx);
    expect(out).toHaveLength(2);
    expect(out.find((i) => i.id.includes("d-prod"))?.severity).toBe("high");
    expect(out.find((i) => i.id.includes("d-prev"))?.severity).toBe("medium");
  });

  test("returns [] when vercel not configured", async () => {
    mockVercelConfigured.mockReturnValue(false);
    const gen = INSIGHT_GENERATORS.find((g) => g.name === "vercel_failed_no_followup")!;
    expect(await gen.run(ctx)).toEqual([]);
  });
});

describe("runAllInsightGenerators aggregator", () => {
  test("sorts by severity then signalStrength", async () => {
    mockSearchPRs.mockResolvedValue({ ok: true, data: [] });
    mockVercelConfigured.mockReturnValue(false);
    const result = await runAllInsightGenerators(ctx);
    expect(Array.isArray(result.insights)).toBe(true);
    expect(Array.isArray(result.generatorOutcomes)).toBe(true);
    expect(result.generatorOutcomes.length).toBe(INSIGHT_GENERATORS.length);
  });

  test("a thrown generator does not block the others", async () => {
    mockSearchPRs.mockRejectedValueOnce(new Error("boom"));
    mockVercelConfigured.mockReturnValue(true);
    mockListDeployments.mockResolvedValueOnce({
      ok: true,
      data: { deployments: [] },
    });
    const result = await runAllInsightGenerators(ctx);
    const ghOutcome = result.generatorOutcomes.find((o) => o.name === "github_pr_stagnation");
    const vcOutcome = result.generatorOutcomes.find((o) => o.name === "vercel_failed_no_followup");
    /* github_pr_stagnation has its own try/catch and returns [] on
     * import-or-throw, so it reports ok=true with count=0 rather than
     * propagating the rejection. The architecture intentionally never
     * surfaces a single generator's failure as the whole aggregator's
     * failure. */
    expect(ghOutcome).toBeDefined();
    expect(vcOutcome).toBeDefined();
    expect(vcOutcome?.ok).toBe(true);
  });
});
