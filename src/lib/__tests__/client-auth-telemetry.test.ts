/**
 * @jest-environment jsdom
 */

/**
 * sendTelemetry + the not-connected contract as fetchWithRefresh sees it.
 *
 * The post-merge E2E run on /emails logged a 401 on /api/analytics on every
 * visit. The cause was a beacon with no Authorization header (the badge-poll
 * counter flush), and the same shape in the role-mismatch report. /api/analytics
 * keeps requiring the token (it writes user-attributed rows), so the fix is on
 * the sending side: every beacon carries the token, and with no session the
 * event is dropped rather than sent to fail.
 *
 * And the other half: a 200 { connected: false } must not trigger a refresh.
 * Only a 401 does, which is why "not connected" can no longer be a 401.
 */
const store: Record<string, string> = {};
Object.defineProperty(window, "localStorage", {
  value: {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => {
      store[k] = v;
    },
    removeItem: (k: string) => {
      delete store[k];
    },
  },
  writable: true,
});

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

import { fetchWithRefresh, sendTelemetry } from "@/lib/client-auth";

function token(): string {
  const body = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString(
    "base64url",
  );
  return `h.${body}.s`;
}

function reply(status: number, body: unknown = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as unknown as Response;
}

function calls(fragment: string) {
  return mockFetch.mock.calls.filter((c) => String(c[0]).includes(fragment));
}

beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockResolvedValue(reply(200));
  for (const k of Object.keys(store)) delete store[k];
});

describe("sendTelemetry", () => {
  it("sends the Bearer token with the event", () => {
    const t = token();
    store["instinct_token"] = t;
    expect(sendTelemetry("system.badge_poll_optimized", { requests_saved: 3 })).toBe(true);
    const [call] = calls("/api/analytics");
    const init = call[1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${t}`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      event: "system.badge_poll_optimized",
      metadata: { requests_saved: 3 },
    });
  });

  it("drops the event when there is no session instead of sending a request that 401s", () => {
    expect(sendTelemetry("system.badge_poll_optimized", {})).toBe(false);
    expect(calls("/api/analytics")).toHaveLength(0);
  });

  it("never throws when fetch rejects", () => {
    store["instinct_token"] = token();
    mockFetch.mockRejectedValueOnce(new Error("offline"));
    expect(() => sendTelemetry("x.y_happened")).not.toThrow();
  });
});

describe("role-mismatch report", () => {
  it("carries the token (it used to send none and 401)", async () => {
    const t = token();
    store["instinct_token"] = t;
    store["instinct_user"] = JSON.stringify({ role: "dealer" });
    mockFetch.mockResolvedValue(reply(403));
    await fetchWithRefresh("/api/orgs/8f21a3b4-1c2d-4e5f-8a9b-0c1d2e3f4a5b/users", { method: "POST" });
    await Promise.resolve();
    const [call] = calls("/api/analytics");
    expect(call).toBeDefined();
    expect(((call[1] as RequestInit).headers as Record<string, string>).Authorization).toBe(`Bearer ${t}`);
  });
});

describe("fetchWithRefresh and a provider that is not connected", () => {
  it("a 200 { connected: false } is returned as-is: no refresh, no retry, no redirect", async () => {
    store["instinct_token"] = token();
    mockFetch.mockResolvedValueOnce(
      reply(200, { messages: [], connected: false, error: "microsoft_not_connected" }),
    );
    const res = await fetchWithRefresh("/api/emails/inbox?folder=inbox");
    expect(res.status).toBe(200);
    expect(calls("/api/auth/refresh")).toHaveLength(0);
    expect(calls("/api/emails/inbox")).toHaveLength(1);
  });

  it("a 409 { connected: false } on an action is returned as-is, with no refresh", async () => {
    store["instinct_token"] = token();
    mockFetch.mockResolvedValueOnce(reply(409, { connected: false, error: "microsoft_not_connected" }));
    const res = await fetchWithRefresh("/api/mail/send", { method: "POST" });
    expect(res.status).toBe(409);
    expect(calls("/api/auth/refresh")).toHaveLength(0);
  });

  it("a 401 still means the session: it refreshes once and retries", async () => {
    store["instinct_token"] = token();
    mockFetch
      .mockResolvedValueOnce(reply(401))
      .mockResolvedValueOnce(reply(200, { token: token() }))
      .mockResolvedValueOnce(reply(200, { messages: [] }));
    const res = await fetchWithRefresh("/api/emails/inbox");
    expect(res.status).toBe(200);
    expect(calls("/api/auth/refresh")).toHaveLength(1);
    expect(calls("/api/emails/inbox")).toHaveLength(2);
  });
});
