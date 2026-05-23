/**
 * vercelProvider — universal-search behavior.
 *   - isEnabled gated by VERCEL_API_TOKEN
 *   - single-word query → projectName filter
 *   - multi-word query → recent-deploys + substring filter
 *   - error from API degrades to []
 *   - result shape conforms to SearchResult
 */

const mockListDeployments = jest.fn();
const mockVercelConfigured = jest.fn();

jest.mock("@/lib/integrations/vercel", () => ({
  listDeployments: (...a: unknown[]) => mockListDeployments(...a),
  vercelIsConfigured: () => mockVercelConfigured(),
  deploymentDashboardUrl: () => "https://vercel.com/dashboard",
}));

import { vercelProvider } from "@/lib/search/providers/vercel";

const ctx = { userId: "u1" };

beforeEach(() => {
  mockListDeployments.mockReset();
  mockVercelConfigured.mockReset();
});

describe("vercelProvider.isEnabled", () => {
  test("false when not configured", () => {
    mockVercelConfigured.mockReturnValue(false);
    expect(vercelProvider.isEnabled(ctx)).toBe(false);
  });
  test("true when configured", () => {
    mockVercelConfigured.mockReturnValue(true);
    expect(vercelProvider.isEnabled(ctx)).toBe(true);
  });
});

describe("vercelProvider.search", () => {
  beforeEach(() => mockVercelConfigured.mockReturnValue(true));

  test("returns [] when query empty", async () => {
    const r = await vercelProvider.search("", 5, ctx);
    expect(r).toEqual([]);
    expect(mockListDeployments).not.toHaveBeenCalled();
  });

  test("returns [] when token not configured", async () => {
    mockVercelConfigured.mockReturnValue(false);
    const r = await vercelProvider.search("wolfpack-auto", 5, ctx);
    expect(r).toEqual([]);
  });

  test("single-word query filters by projectName", async () => {
    mockListDeployments.mockResolvedValueOnce({
      ok: true,
      data: {
        deployments: [
          {
            uid: "d1",
            name: "wolfpack-auto",
            url: "wolfpack-auto.vercel.app",
            state: "READY",
            target: "production",
            createdAt: 1000,
            readyAt: 2000,
            meta: { githubCommitMessage: "fix: thing", githubCommitRef: "main" },
          },
        ],
      },
    });
    const r = await vercelProvider.search("wolfpack-auto", 5, ctx);
    expect(mockListDeployments).toHaveBeenCalledWith({
      projectName: "wolfpack-auto",
      limit: 5,
    });
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({
      type: "vercel",
      id: "d1",
      title: "wolfpack-auto",
      url: "https://vercel.com/dashboard",
    });
    expect(r[0].snippet).toMatch(/READY/);
    expect(r[0].snippet).toMatch(/production/);
  });

  test("multi-word query fetches recent deploys then substring filters", async () => {
    mockListDeployments.mockResolvedValueOnce({
      ok: true,
      data: {
        deployments: [
          { uid: "a", name: "wolfpack-auto", url: "x", state: "READY", target: "production", createdAt: 1 },
          { uid: "b", name: "unrelated", url: "y", state: "READY", target: "production", createdAt: 1 },
        ],
      },
    });
    const r = await vercelProvider.search("wolfpack auto", 5, ctx);
    expect(mockListDeployments).toHaveBeenCalledWith({ limit: 15 });
    expect(r).toHaveLength(1);
    expect(r[0].id).toBe("a");
  });

  test("API error degrades to []", async () => {
    mockListDeployments.mockResolvedValueOnce({ ok: false, error: "boom" });
    const r = await vercelProvider.search("wolfpack-auto", 5, ctx);
    expect(r).toEqual([]);
  });
});
