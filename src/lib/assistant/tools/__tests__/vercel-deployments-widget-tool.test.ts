/**
 * vercel_deployments_widget — intent matching + handler shape.
 * Mocks the Vercel API wrapper so the test doesn't need a real token.
 */

const mockTrackEvent = jest.fn();
const mockListDeployments = jest.fn();
const mockVercelConfigured = jest.fn();

jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: unknown[]) => mockTrackEvent(...a),
}));
jest.mock("@/lib/db", () => ({ safeQuery: jest.fn() }));
jest.mock("@/lib/integrations/vercel", () => ({
  listDeployments: (...a: unknown[]) => mockListDeployments(...a),
  vercelIsConfigured: () => mockVercelConfigured(),
  deploymentDashboardUrl: () => "https://vercel.com/dashboard",
}));

import { vercelDeploymentsWidgetTool } from "@/lib/assistant/tools/vercel-deployments-widget-tool";

const match = (q: string) => vercelDeploymentsWidgetTool.matchIntent!(q);
const CTX = { userId: "u1", userRole: "cto" };

beforeEach(() => {
  mockTrackEvent.mockReset();
  mockListDeployments.mockReset();
  mockVercelConfigured.mockReset();
});

describe("intent matching", () => {
  test.each([
    "show vercel deploys for wolfpack-auto",
    "latest deploys of wolfpack-auto",
    "deploy status for instinct",
    "vercel deployments",
    "show me the recent builds",
    "show deploys for wolfpack-instinct",
    "show vercel builds of wolfpack-aidan-mulready",
  ])("'%s' matches", (q) => {
    expect(match(q)).not.toBeNull();
  });

  test.each([
    "what's our revenue this quarter",
    "find emails from hoxsie",
    "show me 2024 hondas",
    "calendar",
    "search Porsche",
  ])("'%s' does NOT match", (q) => {
    expect(match(q)).toBeNull();
  });

  test("captures explicit 'for <project>' phrasing", () => {
    expect(match("show vercel deploys for wolfpack-auto")).toMatchObject({
      projectName: "wolfpack-auto",
    });
  });

  test("bare 'vercel deployments' has undefined projectName", () => {
    const m = match("vercel deployments");
    expect(m?.projectName).toBeUndefined();
  });

  test("only the explicit 'for/of/on <project>' phrasing sets projectName", () => {
    // Bare hyphenated token without for/of/on stays undefined to avoid
    // false-positives like 'show vercel deploys wolfpack-auto' being
    // captured ambiguously. The user can be explicit with 'for wolfpack-auto'.
    expect(match("show vercel deploys for wolfpack-auto")?.projectName).toBe(
      "wolfpack-auto",
    );
    expect(match("show vercel deploys wolfpack-auto")?.projectName).toBeUndefined();
  });
});

describe("handler", () => {
  test("returns helpful guidance when Vercel not configured", async () => {
    mockVercelConfigured.mockReturnValue(false);
    const r = await vercelDeploymentsWidgetTool.handler(
      { projectName: "wolfpack-auto", limit: 8 },
      CTX,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.answer).toMatch(/VERCEL_API_TOKEN/);
    expect(r.widget?.kind).toBe("vercel_deployments");
  });

  test("returns deployments and emits widget_offered event", async () => {
    mockVercelConfigured.mockReturnValue(true);
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
            meta: { githubCommitMessage: "fix: oops", githubCommitRef: "main", githubCommitSha: "abcdef1234" },
            creator: { username: "homyk" },
          },
        ],
      },
    });
    const r = await vercelDeploymentsWidgetTool.handler(
      { projectName: "wolfpack-auto", limit: 8 },
      CTX,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data?.itemCount).toBe(1);
    expect(r.widget?.kind).toBe("vercel_deployments");
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "assistant.widget_offered",
      "u1",
      "cto",
      expect.objectContaining({
        widget_kind: "vercel_deployments",
        project_name: "wolfpack-auto",
        item_count: 1,
        ok: true,
      }),
    );
  });

  test("surfaces API errors in the answer", async () => {
    mockVercelConfigured.mockReturnValue(true);
    mockListDeployments.mockResolvedValueOnce({ ok: false, error: "rate limited" });
    const r = await vercelDeploymentsWidgetTool.handler({ projectName: "p", limit: 8 }, CTX);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.answer).toMatch(/rate limited/);
  });
});
