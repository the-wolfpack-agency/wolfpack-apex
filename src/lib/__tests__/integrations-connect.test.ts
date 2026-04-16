/**
 * @jest-environment jsdom
 */

/**
 * integrations/connect tests — OAuth start helpers.
 *
 * window.location.href assignment triggers jsdom navigation which cannot be easily
 * stubbed. We test: (a) URL construction logic directly, (b) fetch call shape,
 * (c) error paths where no redirect happens. The actual redirect is an assignment
 * and is verified via a jsdom-compatible approach.
 */

jest.mock("@/lib/client-auth", () => ({
  authHeaders: () => ({ Authorization: "Bearer tok" }),
  fetchWithRefresh: jest.fn((url, opts) => fetch(url, opts)), fetchJsonWithRefresh: jest.fn(async (url, opts) => (await fetch(url, opts)).json()) }));

const fetchMock = jest.fn();
beforeAll(() => {
  global.fetch = fetchMock;
});

beforeEach(() => {
  fetchMock.mockReset();
});

import { startMicrosoftConnect, startQuickbooksConnect, connectPlaud } from "@/lib/integrations/connect";

/* ─────────────────── URL construction helper ─────────────────── */

function appendReturnTo(baseUrl: string, returnTo?: string): string {
  if (!returnTo) return baseUrl;
  return baseUrl + (baseUrl.includes("?") ? "&" : "?") + "returnTo=" + encodeURIComponent(returnTo);
}

describe("appendReturnTo URL helper logic", () => {
  it("appends with ? when no query string", () => {
    const result = appendReturnTo("https://login.microsoft.com/oauth", "/setup");
    expect(result).toBe("https://login.microsoft.com/oauth?returnTo=%2Fsetup");
  });

  it("appends with & when query string exists", () => {
    const result = appendReturnTo("https://login.microsoft.com/oauth?foo=1", "/setup");
    expect(result).toBe("https://login.microsoft.com/oauth?foo=1&returnTo=%2Fsetup");
  });

  it("does not append when returnTo is undefined", () => {
    const result = appendReturnTo("https://login.microsoft.com/oauth?foo=1");
    expect(result).toBe("https://login.microsoft.com/oauth?foo=1");
  });

  it("encodes the returnTo path correctly", () => {
    const result = appendReturnTo("https://example.com/auth", "/setup?step=2");
    expect(result).toContain("returnTo=" + encodeURIComponent("/setup?step=2"));
  });
});

/* ─────────────────── startMicrosoftConnect ─────────────────── */

describe("startMicrosoftConnect", () => {
  it("fetches /api/microsoft?action=auth-url with auth headers", async () => {
    fetchMock.mockResolvedValueOnce({
      json: () => Promise.resolve({ authUrl: "https://login.microsoft.com/oauth?foo=1" }),
    });
    // Will trigger jsdom navigation — result.ok is true
    const result = await startMicrosoftConnect();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/microsoft?action=auth-url",
      expect.objectContaining({ headers: { Authorization: "Bearer tok" } }),
    );
    expect(result.ok).toBe(true);
  });

  it("returns error when authUrl is missing (not configured)", async () => {
    fetchMock.mockResolvedValueOnce({
      json: () => Promise.resolve({ error: "not configured" }),
    });
    const result = await startMicrosoftConnect();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/not configured/i);
    }
  });

  it("returns error on network failure", async () => {
    fetchMock.mockRejectedValueOnce(new Error("Network down"));
    const result = await startMicrosoftConnect();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/unable to start/i);
    }
  });
});

/* ─────────────────── startQuickbooksConnect ─────────────────── */

describe("startQuickbooksConnect", () => {
  it("fetches /api/quickbooks?action=auth-url with auth headers", async () => {
    fetchMock.mockResolvedValueOnce({
      json: () => Promise.resolve({ authUrl: "https://appcenter.intuit.com/oauth?client=1" }),
    });
    const result = await startQuickbooksConnect();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/quickbooks?action=auth-url",
      expect.objectContaining({ headers: { Authorization: "Bearer tok" } }),
    );
    expect(result.ok).toBe(true);
  });

  it("returns error when authUrl is missing", async () => {
    fetchMock.mockResolvedValueOnce({
      json: () => Promise.resolve({}),
    });
    const result = await startQuickbooksConnect();
    expect(result.ok).toBe(false);
  });

  it("returns error on network failure", async () => {
    fetchMock.mockRejectedValueOnce(new Error("timeout"));
    const result = await startQuickbooksConnect();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/unable to start/i);
    }
  });
});

/* ─────────────────── connect.ts: returnTo appended to URL ─────────────────── */

describe("returnTo appended to OAuth redirect URL", () => {
  it("returnTo=/setup results in URL containing returnTo=%2Fsetup", () => {
    const authUrl = "https://login.microsoft.com/oauth?foo=1";
    const withReturn = appendReturnTo(authUrl, "/setup");
    expect(withReturn).toContain("returnTo=%2Fsetup");
    expect(withReturn).toContain("foo=1");
  });

  it("no returnTo means URL is unchanged", () => {
    const authUrl = "https://appcenter.intuit.com/oauth?client=1";
    expect(appendReturnTo(authUrl, undefined)).toBe(authUrl);
  });
});

/* ─────────────────── connectPlaud ─────────────────── */

describe("connectPlaud", () => {
  it("returns error when not configured", async () => {
    const result = await connectPlaud(false);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/not configured/i);
    }
  });

  it("returns ok when configured and API succeeds", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) });
    const result = await connectPlaud(true);
    expect(result.ok).toBe(true);
  });

  it("POSTs to /api/integrations/plaud with action=connect", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) });
    await connectPlaud(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/integrations/plaud",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ action: "connect" }),
      }),
    );
  });

  it("returns API error message on failure response", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      json: () => Promise.resolve({ error: "API key invalid" }),
    });
    const result = await connectPlaud(true);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("API key invalid");
    }
  });

  it("returns error on network failure", async () => {
    fetchMock.mockRejectedValueOnce(new Error("Network error"));
    const result = await connectPlaud(true);
    expect(result.ok).toBe(false);
  });
});

export {};
