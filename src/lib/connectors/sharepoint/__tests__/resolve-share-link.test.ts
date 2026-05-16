/**
 * resolve-share-link: encodes a SharePoint share token and asks Graph
 * for the canonical driveItem. Tested against a mocked fetcher; no real
 * Graph call.
 */

jest.mock("@/lib/microsoft-graph", () => ({
  getValidToken: jest.fn().mockResolvedValue({ accessToken: "tok", userEmail: "u@x.co" }),
}));

import {
  isShortShareLink,
  resolveShareLink,
} from "@/lib/connectors/sharepoint/resolve-share-link";

describe("isShortShareLink", () => {
  test.each([
    ["https://t.sharepoint.com/:f:/s/SITE/abc", true],
    ["https://t.sharepoint.com/:f:/r/sites/SITE/Shared Documents/X", true],
    ["https://t.sharepoint.com/:w:/s/SITE/abc", true],
    ["https://t.sharepoint.com/:x:/s/SITE/abc", true],
    ["https://t.sharepoint.com/sites/SITE/Shared%20Documents/X", false],
    ["https://t.sharepoint.com/Documents/", false],
  ])("'%s' → %s", (url, expected) => {
    expect(isShortShareLink(url)).toBe(expected);
  });
});

describe("resolveShareLink", () => {
  test("base64url encodes URL with u! prefix in Graph call", async () => {
    const fakeFetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        id: "01ABC",
        name: "Program Evals",
        webUrl: "https://t.sharepoint.com/sites/PCNAINTERNAL/Shared%20Documents/Program%20Evals",
        parentReference: { driveId: "drv-1" },
        folder: { childCount: 5 },
      }),
    }) as unknown as Response);

    const out = await resolveShareLink(
      "u1",
      "https://t.sharepoint.com/:f:/s/PCNAINTERNAL/abc",
      fakeFetch as unknown as typeof fetch,
    );
    expect(out.ok).toBe(true);
    expect(out.webUrl).toContain("/sites/PCNAINTERNAL/Shared%20Documents/Program%20Evals");
    expect(out.driveId).toBe("drv-1");
    expect(out.itemId).toBe("01ABC");

    const callUrl = String((fakeFetch.mock.calls[0] as unknown as [string])[0]);
    expect(callUrl).toMatch(/\/shares\/u!/);
    /* Extract just the base64url token (after `u!`) and assert it
     * has no '+', '/', or '=' (raw base64 chars; we use base64url). */
    const token = callUrl.split("/shares/u!")[1]?.split("/")[0] ?? "";
    expect(token.length).toBeGreaterThan(0);
    expect(token).not.toMatch(/[+/=]/);
  });

  test("returns no_token when user isn't connected", async () => {
    const { getValidToken } = jest.requireMock("@/lib/microsoft-graph");
    getValidToken.mockResolvedValueOnce(null);
    const fakeFetch = jest.fn();
    const out = await resolveShareLink("u1", "https://t.sharepoint.com/:f:/s/X/abc", fakeFetch as unknown as typeof fetch);
    expect(out.ok).toBe(false);
    expect(out.error).toBe("no_token");
    expect(fakeFetch).not.toHaveBeenCalled();
  });

  test("surfaces graph_404 when share token is invalid/expired", async () => {
    const fakeFetch = jest.fn(async () => ({
      ok: false,
      status: 404,
      json: async () => ({}),
    }) as unknown as Response);
    const out = await resolveShareLink("u1", "https://t.sharepoint.com/:f:/s/X/bad", fakeFetch as unknown as typeof fetch);
    expect(out.ok).toBe(false);
    expect(out.error).toBe("graph_404");
  });

  test("returns no_web_url_in_response when payload is malformed", async () => {
    const fakeFetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ id: "x" /* no webUrl */ }),
    }) as unknown as Response);
    const out = await resolveShareLink("u1", "https://t.sharepoint.com/:f:/s/X/abc", fakeFetch as unknown as typeof fetch);
    expect(out.ok).toBe(false);
    expect(out.error).toBe("no_web_url_in_response");
  });
});
