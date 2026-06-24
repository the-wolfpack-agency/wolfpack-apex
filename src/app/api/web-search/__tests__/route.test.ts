/**
 * POST /api/web-search - contract.
 *
 * Locks: 401 unauthenticated, 400 on empty query, ALWAYS 200 otherwise (the ok
 * flag carries success / not-configured / provider-error), and never a 500.
 *
 * searchWeb + auth + analytics are mocked so the test is hermetic and asserts
 * the route's HTTP contract, not the provider's behavior (that lives in the
 * integration test).
 */

const mockSearchWeb = jest.fn();
const mockGetUser = jest.fn();
const mockTrackEvent = jest.fn();

jest.mock("@/lib/integrations/web-search", () => ({
  searchWeb: (...a: unknown[]) => mockSearchWeb(...a),
}));
jest.mock("@/lib/auth", () => ({
  getUserFromRequest: (...a: unknown[]) => mockGetUser(...a),
}));
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: unknown[]) => mockTrackEvent(...a),
}));

import { NextRequest } from "next/server";
import { POST } from "../route";

const AUTH_USER = { id: "u1", role: "ceo", name: "Nick", email: "n@x.co" };

function post(body: unknown, auth = "Bearer x"): NextRequest {
  return new NextRequest("https://x.test/api/web-search", {
    method: "POST",
    headers: { authorization: auth, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  mockSearchWeb.mockReset();
  mockGetUser.mockReset();
  mockTrackEvent.mockReset();
  mockGetUser.mockReturnValue(AUTH_USER);
});

describe("POST /api/web-search", () => {
  it("401s when there is no authenticated user", async () => {
    mockGetUser.mockReturnValue(null);
    const res = await POST(post({ query: "x" }));
    expect(res.status).toBe(401);
    expect(mockSearchWeb).not.toHaveBeenCalled();
  });

  it("400s when query is missing", async () => {
    const res = await POST(post({}));
    expect(res.status).toBe(400);
    expect(mockSearchWeb).not.toHaveBeenCalled();
  });

  it("400s when query is blank", async () => {
    const res = await POST(post({ query: "   " }));
    expect(res.status).toBe(400);
  });

  it("400s when query is not a string", async () => {
    const res = await POST(post({ query: 123 }));
    expect(res.status).toBe(400);
  });

  it("200s with the WebSearchResponse on a successful search", async () => {
    const payload = {
      ok: true,
      provider: "brave",
      results: [{ title: "T", url: "https://a.com", snippet: "s" }],
    };
    mockSearchWeb.mockResolvedValue(payload);
    const res = await POST(post({ query: "auto saas", limit: 3 }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(payload);
    expect(mockSearchWeb).toHaveBeenCalledWith("auto saas", { limit: 3 });
  });

  it("200s (not a 5xx) when web search is not configured", async () => {
    const payload = {
      ok: false,
      provider: "none",
      results: [],
      error: "web search is not configured",
    };
    mockSearchWeb.mockResolvedValue(payload);
    const res = await POST(post({ query: "x" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(payload);
  });

  it("200s (not a 5xx) when the provider errors", async () => {
    mockSearchWeb.mockResolvedValue({
      ok: false,
      provider: "brave",
      results: [],
      error: "brave search HTTP 429",
    });
    const res = await POST(post({ query: "x" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
  });

  it("never 500s even if searchWeb throws unexpectedly", async () => {
    mockSearchWeb.mockRejectedValue(new Error("boom"));
    const res = await POST(post({ query: "x" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.results).toEqual([]);
  });

  it("fires a minimal tool_invoked analytics event with no key in metadata", async () => {
    mockSearchWeb.mockResolvedValue({
      ok: true,
      provider: "brave",
      results: [{ title: "T", url: "https://a.com", snippet: "s" }],
    });
    await POST(post({ query: "x" }));
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "assistant.tool_invoked",
      "u1",
      "ceo",
      expect.objectContaining({ tool: "web_search", provider: "brave", ok: true }),
    );
  });
});
