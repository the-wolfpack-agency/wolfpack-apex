/**
 * RestConnector tests — covers configuration, request shape, response
 * tolerance (bare-array OR {results:[]}), and every error branch.
 * The fetch implementation is injected so no real network is hit.
 */

const mockTrack = jest.fn();
const mockRefresh = jest.fn();
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: any[]) => mockTrack(...a),
}));
jest.mock("@/lib/assistant/connectors/oauth/refresh", () => ({
  refreshConnectorAccessToken: (...a: any[]) => mockRefresh(...a),
}));

import { RestConnector } from "@/lib/assistant/connectors/rest-connector";

function fakeRes(status: number, body: unknown): any {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  };
}

beforeEach(() => {
  mockTrack.mockClear();
  mockRefresh.mockReset();
});

describe("RestConnector — configuration", () => {
  test("isConfigured=false when env is empty", () => {
    const c = new RestConnector({ baseUrl: undefined, authHeader: undefined });
    expect(c.isConfigured()).toBe(false);
  });

  test("isConfigured=true when both base + auth set", () => {
    const c = new RestConnector({
      baseUrl: "https://api.example.com",
      authHeader: "Bearer x",
    });
    expect(c.isConfigured()).toBe(true);
  });

  test("getRecord returns not_configured when unconfigured", async () => {
    const c = new RestConnector({});
    const r = await c.getRecord("contact", "abc");
    expect(r.ok).toBe(false);
    expect(r.code).toBe("not_configured");
  });
});

describe("RestConnector — getRecord", () => {
  function mk(fetchImpl: jest.Mock) {
    return new RestConnector({
      baseUrl: "https://api.example.com/v1",
      authHeader: "Bearer test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
  }

  test("happy path: returns parsed body + fires success analytics", async () => {
    const f = jest.fn().mockResolvedValueOnce(fakeRes(200, { id: "abc", name: "Acme" }));
    const c = mk(f);
    const r = await c.getRecord("contact", "abc");
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({ id: "abc", name: "Acme" });
    expect(f).toHaveBeenCalledWith(
      "https://api.example.com/v1/contacts/abc",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer test" }),
      }),
    );
    expect(mockTrack).toHaveBeenCalledWith(
      "assistant.connector_succeeded",
      "system",
      "system",
      expect.objectContaining({ connector: "rest-default", code: "ok" }),
    );
  });

  test("object map: 'company' → 'companies' (default mapping)", async () => {
    const f = jest.fn().mockResolvedValueOnce(fakeRes(200, {}));
    const c = mk(f);
    await c.getRecord("company", "xyz");
    expect(f.mock.calls[0][0]).toBe("https://api.example.com/v1/companies/xyz");
  });

  test("custom object map overrides defaults", async () => {
    const f = jest.fn().mockResolvedValueOnce(fakeRes(200, {}));
    const c = new RestConnector({
      baseUrl: "https://api.x",
      authHeader: "Bearer t",
      objectMap: { deal: "v2/opportunities" },
      fetchImpl: f as unknown as typeof fetch,
    });
    await c.getRecord("deal", "d1");
    expect(f.mock.calls[0][0]).toBe("https://api.x/v2/opportunities/d1");
  });

  test("401 → code=auth_failed", async () => {
    const f = jest.fn().mockResolvedValueOnce(fakeRes(401, { error: "no" }));
    const c = mk(f);
    const r = await c.getRecord("contact", "x");
    expect(r.ok).toBe(false);
    expect(r.code).toBe("auth_failed");
  });

  test("404 → code=not_found", async () => {
    const f = jest.fn().mockResolvedValueOnce(fakeRes(404, {}));
    const c = mk(f);
    const r = await c.getRecord("contact", "ghost");
    expect(r.code).toBe("not_found");
  });

  test("429 → code=rate_limited", async () => {
    const f = jest.fn().mockResolvedValueOnce(fakeRes(429, {}));
    const c = mk(f);
    expect((await c.getRecord("contact", "x")).code).toBe("rate_limited");
  });

  test("5xx → code=remote_error", async () => {
    const f = jest.fn().mockResolvedValueOnce(fakeRes(500, {}));
    const c = mk(f);
    expect((await c.getRecord("contact", "x")).code).toBe("remote_error");
  });

  test("network throw → code=network", async () => {
    const f = jest.fn().mockRejectedValueOnce(new Error("connection refused"));
    const c = mk(f);
    const r = await c.getRecord("contact", "x");
    expect(r.code).toBe("network");
  });

  test("non-JSON body → code=remote_error", async () => {
    const f = jest.fn().mockResolvedValueOnce({
      status: 200,
      ok: true,
      json: async () => { throw new SyntaxError("not json"); },
    });
    const c = mk(f as any);
    expect((await c.getRecord("contact", "x")).code).toBe("remote_error");
  });
});

describe("RestConnector — searchRecords", () => {
  test("rejects short queries with code=validation", async () => {
    const f = jest.fn();
    const c = new RestConnector({
      baseUrl: "https://x",
      authHeader: "Bearer y",
      fetchImpl: f as unknown as typeof fetch,
    });
    const r = await c.searchRecords("contact", "a");
    expect(r.ok).toBe(false);
    expect(r.code).toBe("validation");
    expect(f).not.toHaveBeenCalled();
  });

  test("tolerates bare-array response shape", async () => {
    const f = jest.fn().mockResolvedValueOnce(
      fakeRes(200, [{ id: "1" }, { id: "2" }]),
    );
    const c = new RestConnector({
      baseUrl: "https://x",
      authHeader: "Bearer y",
      fetchImpl: f as unknown as typeof fetch,
    });
    const r = await c.searchRecords("contact", "acme");
    expect(r.ok).toBe(true);
    expect(r.data).toHaveLength(2);
  });

  test("tolerates {results:[]} response shape", async () => {
    const f = jest.fn().mockResolvedValueOnce(
      fakeRes(200, { results: [{ id: "1" }], total: 1 }),
    );
    const c = new RestConnector({
      baseUrl: "https://x",
      authHeader: "Bearer y",
      fetchImpl: f as unknown as typeof fetch,
    });
    const r = await c.searchRecords("contact", "acme");
    expect(r.ok).toBe(true);
    expect(r.data).toHaveLength(1);
  });

  test("URL-encodes the query + appends limit", async () => {
    const f = jest.fn().mockResolvedValueOnce(fakeRes(200, []));
    const c = new RestConnector({
      baseUrl: "https://x",
      authHeader: "Bearer y",
      fetchImpl: f as unknown as typeof fetch,
    });
    await c.searchRecords("contact", "Acme & Sons", 5);
    expect(f.mock.calls[0][0]).toContain("q=Acme%20%26%20Sons");
    expect(f.mock.calls[0][0]).toContain("limit=5");
  });
});

// ---------------------------------------------------------------------------
// Refresh-on-401 (OAuth-backed connectors only)
// ---------------------------------------------------------------------------

describe("RestConnector — refresh-on-401", () => {
  test("OAuth-backed connector (workspaceId set): 401 triggers refresh + retry, returns retry result", async () => {
    /* First fetch: stale token returns 401. */
    /* Second fetch (after refresh): fresh token returns the record. */
    const f = jest.fn()
      .mockResolvedValueOnce(fakeRes(401, { error: "expired" }))
      .mockResolvedValueOnce(fakeRes(200, { id: "abc-123", name: "Acme" }));
    mockRefresh.mockResolvedValueOnce({
      workspaceId: "ws1",
      connectorName: "salesforce",
      authHeader: "Bearer FRESH_TOKEN",
      baseUrl: "https://acme.my.salesforce.com",
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      metadata: { instance_url: "https://acme.my.salesforce.com" },
    });

    const c = new RestConnector({
      name: "salesforce",
      baseUrl: "https://prior.salesforce.com",
      authHeader: "Bearer STALE_TOKEN",
      workspaceId: "ws1",
      fetchImpl: f as unknown as typeof fetch,
    });
    const r = await c.getRecord("contact", "abc-123");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toEqual({ id: "abc-123", name: "Acme" });

    /* Refresh was called once with the workspace + connector. */
    expect(mockRefresh).toHaveBeenCalledTimes(1);
    expect(mockRefresh).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws1", connectorName: "salesforce" }),
    );
    /* Retry used the FRESH token, and the base URL was rotated to
       Salesforce's instance_url. */
    expect(f).toHaveBeenCalledTimes(2);
    const retryHeaders = (f.mock.calls[1][1] as any).headers;
    expect(retryHeaders.Authorization).toBe("Bearer FRESH_TOKEN");
    expect(f.mock.calls[1][0]).toContain("https://acme.my.salesforce.com");
  });

  test("static-bearer connector (no workspaceId): 401 returns auth_failed immediately, no refresh", async () => {
    const f = jest.fn().mockResolvedValueOnce(fakeRes(401, {}));
    const c = new RestConnector({
      baseUrl: "https://x",
      authHeader: "Bearer y",
      fetchImpl: f as unknown as typeof fetch,
    });
    const r = await c.getRecord("contact", "x");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("auth_failed");
    expect(mockRefresh).not.toHaveBeenCalled();
    expect(f).toHaveBeenCalledTimes(1);
  });

  test("refresh returns null → connector returns auth_failed (no infinite loop)", async () => {
    const f = jest.fn().mockResolvedValueOnce(fakeRes(401, {}));
    mockRefresh.mockResolvedValueOnce(null);
    const c = new RestConnector({
      name: "salesforce",
      baseUrl: "https://x",
      authHeader: "Bearer stale",
      workspaceId: "ws1",
      fetchImpl: f as unknown as typeof fetch,
    });
    const r = await c.getRecord("contact", "x");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("auth_failed");
    expect(mockRefresh).toHaveBeenCalledTimes(1);
    expect(f).toHaveBeenCalledTimes(1);
  });

  test("retry that also 401s does NOT trigger a second refresh (single-retry contract)", async () => {
    const f = jest.fn()
      .mockResolvedValueOnce(fakeRes(401, {}))
      .mockResolvedValueOnce(fakeRes(401, {}));
    mockRefresh.mockResolvedValueOnce({
      workspaceId: "ws1",
      connectorName: "salesforce",
      authHeader: "Bearer NEW",
      baseUrl: "https://x",
      expiresAt: null,
      metadata: null,
    });
    const c = new RestConnector({
      name: "salesforce",
      baseUrl: "https://x",
      authHeader: "Bearer stale",
      workspaceId: "ws1",
      fetchImpl: f as unknown as typeof fetch,
    });
    const r = await c.getRecord("contact", "x");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("auth_failed");
    expect(mockRefresh).toHaveBeenCalledTimes(1);
    expect(f).toHaveBeenCalledTimes(2);
  });

  test("403 does NOT trigger refresh (permission denied, not stale token)", async () => {
    const f = jest.fn().mockResolvedValueOnce(fakeRes(403, {}));
    const c = new RestConnector({
      name: "salesforce",
      baseUrl: "https://x",
      authHeader: "Bearer y",
      workspaceId: "ws1",
      fetchImpl: f as unknown as typeof fetch,
    });
    const r = await c.getRecord("contact", "x");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("auth_failed");
    expect(mockRefresh).not.toHaveBeenCalled();
  });
});
