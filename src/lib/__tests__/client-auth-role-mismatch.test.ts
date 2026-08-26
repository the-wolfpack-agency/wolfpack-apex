/**
 * @jest-environment jsdom
 */

/**
 * The 403 that reaches the person as a button doing nothing.
 *
 * role-mismatch.test.ts proves the rules. This proves fetchWithRefresh applies
 * them, which is the half that matters: the recording lives at this one
 * chokepoint precisely because every authenticated fetch in the product passes
 * through here, and a rule nobody calls covers nothing.
 *
 * Asserted on the analytics POST, because that is the only observable effect.
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

import { fetchWithRefresh } from "@/lib/client-auth";

/** A far-future JWT, so nothing tries to pre-refresh it. */
function token(): string {
  const body = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString(
    "base64url",
  );
  return `h.${body}.s`;
}

/* jsdom provides no Response, and fetchWithRefresh only reads .status, so a
   minimal stub is both sufficient and clearer about what is being exercised. */
function reply(status: number) {
  /* ok is 200-299 in real fetch, not < 400. A 3xx is not ok, and a double that
     says otherwise teaches a test the wrong contract. A repo guardrail
     (platform-scan/__tests__/fetch-fake-fidelity) fails the build on the
     wrong form, and it caught this one. */
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => ({}),
  } as unknown as Response;
}

function analyticsCalls() {
  return mockFetch.mock.calls.filter((c) => String(c[0]).includes("/api/analytics"));
}

beforeEach(() => {
  mockFetch.mockReset();
  store["instinct_token"] = token();
  store["instinct_user"] = JSON.stringify({ role: "dealer" });
});

describe("a refused control", () => {
  it("is recorded, with the page it was on and the role that saw it", async () => {
    mockFetch.mockResolvedValue(reply(403));
    await fetchWithRefresh("/api/orgs/8f21a3b4-1c2d-4e5f-8a9b-0c1d2e3f4a5b/users", { method: "POST" });

    const [call] = analyticsCalls();
    expect(call).toBeDefined();
    const body = JSON.parse(String((call[1] as RequestInit).body));
    expect(body.event).toBe("ui.role_mismatch_click");
    /* The id is collapsed, so repeat attempts on the same control aggregate
       instead of splitting into one row per record. */
    expect(body.metadata.control).toBe("/api/orgs/:id/users");
    expect(body.metadata.role).toBe("dealer");
    /* Where to remove the control from. */
    expect(body.metadata.surface).toBe("/");
  });

  /* The caller must be unaffected. Telemetry that changes what a request
     returns is worse than no telemetry. */
  it("still returns the 403 to the caller", async () => {
    mockFetch.mockResolvedValue(reply(403));
    const res = await fetchWithRefresh("/api/orgs/8f21a3b4-1c2d-4e5f-8a9b-0c1d2e3f4a5b/users", { method: "POST" });
    expect(res.status).toBe(403);
  });

  it("does not record a successful request", async () => {
    mockFetch.mockResolvedValue(reply(200));
    await fetchWithRefresh("/api/orgs/8f21a3b4-1c2d-4e5f-8a9b-0c1d2e3f4a5b/users", { method: "POST" });
    expect(analyticsCalls()).toHaveLength(0);
  });

  it("does not record a refused read", async () => {
    mockFetch.mockResolvedValue(reply(403));
    await fetchWithRefresh("/api/orgs/8f21a3b4-1c2d-4e5f-8a9b-0c1d2e3f4a5b/users");
    expect(analyticsCalls()).toHaveLength(0);
  });

  /* THE LOOP. A failing analytics POST that reported itself would recurse
     until the tab died. */
  it("does not report a refusal from the analytics endpoint itself", async () => {
    mockFetch.mockResolvedValue(reply(403));
    await fetchWithRefresh("/api/analytics", { method: "POST" });
    expect(analyticsCalls()).toHaveLength(1); // the original call, and no report of it
  });

  /* A telemetry failure must never surface to somebody who already had one
     thing not work. */
  it("survives the report itself failing", async () => {
    mockFetch.mockImplementation((url: string) =>
      String(url).includes("/api/analytics")
        ? Promise.reject(new Error("offline"))
        : Promise.resolve(reply(403)),
    );
    await expect(
      fetchWithRefresh("/api/orgs/8f21a3b4-1c2d-4e5f-8a9b-0c1d2e3f4a5b/users", { method: "POST" }),
    ).resolves.toMatchObject({ status: 403 });
  });
});
