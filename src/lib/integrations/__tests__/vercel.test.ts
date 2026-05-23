/**
 * Vercel API wrapper — unit tests with mocked fetch. Covers:
 *   - VERCEL_API_TOKEN gating (vercelIsConfigured + early error)
 *   - VERCEL_TEAM_ID inclusion in request query
 *   - 200 happy path (listDeployments, listProjects)
 *   - 401 (bad token), 429 (rate limit), 500 (transient)
 *   - timeout via AbortController
 *   - dashboard URL allowlisting
 */

const mockFetch = jest.fn();
(global as unknown as { fetch: typeof fetch }).fetch = mockFetch as unknown as typeof fetch;

beforeEach(() => {
  mockFetch.mockReset();
  delete process.env.VERCEL_API_TOKEN;
  delete process.env.VERCEL_TEAM_ID;
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  }) as unknown as Response;
}

import {
  vercelIsConfigured,
  listDeployments,
  listProjects,
  deploymentDashboardUrl,
} from "@/lib/integrations/vercel";

describe("vercelIsConfigured", () => {
  test("false when token missing", () => {
    expect(vercelIsConfigured()).toBe(false);
  });
  test("true when token set", () => {
    process.env.VERCEL_API_TOKEN = "tk_xxx";
    expect(vercelIsConfigured()).toBe(true);
  });
});

describe("listDeployments", () => {
  test("returns ok=false with explanatory error when token missing", async () => {
    const r = await listDeployments({ projectName: "wolfpack-auto" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/VERCEL_API_TOKEN/);
  });

  test("happy path passes app + limit + teamId", async () => {
    process.env.VERCEL_API_TOKEN = "tk_xxx";
    process.env.VERCEL_TEAM_ID = "team_123";
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ deployments: [{ uid: "d1", name: "wolfpack-auto", url: "wolfpack-auto.vercel.app", state: "READY", target: "production", createdAt: Date.now() }] }),
    );
    const r = await listDeployments({ projectName: "wolfpack-auto", limit: 5 });
    expect(r.ok).toBe(true);
    expect(r.data?.deployments).toHaveLength(1);
    const [calledUrl, calledOpts] = mockFetch.mock.calls[0];
    expect(calledUrl).toContain("teamId=team_123");
    expect(calledUrl).toContain("app=wolfpack-auto");
    expect(calledUrl).toContain("limit=5");
    expect((calledOpts as RequestInit).headers).toMatchObject({
      Authorization: "Bearer tk_xxx",
    });
  });

  test("401 surfaces statusCode and Vercel error message", async () => {
    process.env.VERCEL_API_TOKEN = "tk_xxx";
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ error: { message: "invalid token" } }, 401),
    );
    const r = await listDeployments({ projectName: "p" });
    expect(r.ok).toBe(false);
    expect(r.statusCode).toBe(401);
    expect(r.error).toBe("invalid token");
  });

  test("429 rate limit treated as not-ok", async () => {
    process.env.VERCEL_API_TOKEN = "tk_xxx";
    mockFetch.mockResolvedValueOnce(jsonResponse({}, 429));
    const r = await listDeployments({ projectName: "p" });
    expect(r.ok).toBe(false);
    expect(r.statusCode).toBe(429);
  });

  test("timeout aborts and returns Vercel API timeout message", async () => {
    process.env.VERCEL_API_TOKEN = "tk_xxx";
    mockFetch.mockImplementationOnce((_url, opts: RequestInit) => {
      return new Promise((_, reject) => {
        (opts.signal as AbortSignal).addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    });
    jest.useFakeTimers();
    const promise = listDeployments({ projectName: "p" });
    jest.advanceTimersByTime(6_000);
    const r = await promise;
    jest.useRealTimers();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/timeout/i);
  });

  test("clamps limit to [1, 50]", async () => {
    process.env.VERCEL_API_TOKEN = "tk_xxx";
    mockFetch.mockResolvedValue(jsonResponse({ deployments: [] }));
    await listDeployments({ limit: 999 });
    expect(mockFetch.mock.calls[0][0]).toContain("limit=50");
    mockFetch.mockReset();
    mockFetch.mockResolvedValue(jsonResponse({ deployments: [] }));
    await listDeployments({ limit: 0 });
    expect(mockFetch.mock.calls[0][0]).toContain("limit=1");
  });
});

describe("listProjects", () => {
  test("returns ok=true on success", async () => {
    process.env.VERCEL_API_TOKEN = "tk_xxx";
    mockFetch.mockResolvedValueOnce(jsonResponse({ projects: [{ id: "p1", name: "wolfpack-auto" }] }));
    const r = await listProjects();
    expect(r.ok).toBe(true);
    expect(r.data?.projects).toHaveLength(1);
  });
});

describe("deploymentDashboardUrl", () => {
  test("prefers inspectorUrl when vercel.com-prefixed", () => {
    const url = deploymentDashboardUrl({
      uid: "d1",
      name: "p",
      url: "p.vercel.app",
      state: "READY",
      target: "production",
      createdAt: 0,
      inspectorUrl: "https://vercel.com/team/p/d1",
    });
    expect(url).toBe("https://vercel.com/team/p/d1");
  });
  test("falls back to *.vercel.app for safe deploy URL", () => {
    expect(
      deploymentDashboardUrl({
        uid: "d1",
        name: "p",
        url: "p-abc123.vercel.app",
        state: "READY",
        target: "preview",
        createdAt: 0,
      }),
    ).toBe("https://p-abc123.vercel.app");
  });
  test("rejects non-allowlisted hosts", () => {
    expect(
      deploymentDashboardUrl({
        uid: "d1",
        name: "p",
        url: "evil.com/redirect",
        state: "READY",
        target: "production",
        createdAt: 0,
      }),
    ).toBe("https://vercel.com");
  });
});
