 
/**
 * /api/microsoft/callback redirect contract.
 *
 * Dashboard home lives in the (dashboard) Next route group — the public
 * path is "/", NOT "/dashboard". Callback redirects must use "/".
 */

const mockExchangeCode = jest.fn();
const mockStoreTokens = jest.fn();
const mockFetchUserProfile = jest.fn();
const mockClearCache = jest.fn();
const mockVerifyState = jest.fn();

jest.mock("@/lib/microsoft-graph", () => ({
  exchangeCode: (...a: any[]) => mockExchangeCode(...a),
  storeTokens: (...a: any[]) => mockStoreTokens(...a),
  fetchUserProfile: (...a: any[]) => mockFetchUserProfile(...a),
  clearCache: (...a: any[]) => mockClearCache(...a),
  verifyState: (...a: any[]) => mockVerifyState(...a),
}));
jest.mock("@/lib/auth", () => ({ getUserFromRequest: () => null }));
jest.mock("@/lib/analytics", () => ({ trackEvent: jest.fn() }));

import { NextRequest } from "next/server";
import { GET } from "../route";

function get(url: string): NextRequest {
  return new NextRequest(url, { method: "GET" });
}

beforeEach(() => {
  mockExchangeCode.mockReset();
  mockStoreTokens.mockReset();
  mockFetchUserProfile.mockReset();
  mockClearCache.mockReset();
  mockVerifyState.mockReset();
});

describe("microsoft callback redirects to / (dashboard route group root)", () => {
  test("error=access_denied redirects to /?ms=denied (not /dashboard)", async () => {
    const res = await GET(get("https://x.test/api/microsoft/callback?error=access_denied"));
    expect(res.status).toBe(307);
    const loc = res.headers.get("location")!;
    expect(new URL(loc).pathname).toBe("/");
    expect(new URL(loc).searchParams.get("ms")).toBe("denied");
  });

  test("error= forwards error_code + first line of error_description so the banner can show why", async () => {
    const desc =
      "AADSTS65001: The user or administrator has not consented to use the application with ID 'xxx'.\nTrace ID: abc";
    const res = await GET(
      get(
        `https://x.test/api/microsoft/callback?error=consent_required&error_description=${encodeURIComponent(desc)}`,
      ),
    );
    const loc = new URL(res.headers.get("location")!);
    expect(loc.searchParams.get("ms")).toBe("denied");
    expect(loc.searchParams.get("error_code")).toBe("consent_required");
    expect(loc.searchParams.get("detail")).toContain("AADSTS65001");
    // Multi-line description is truncated to first line
    expect(loc.searchParams.get("detail")).not.toContain("Trace ID");
  });

  test("missing code redirects to /?ms=error", async () => {
    const res = await GET(get("https://x.test/api/microsoft/callback"));
    expect(new URL(res.headers.get("location")!).pathname).toBe("/");
  });

  test("invalid state redirects to /?ms=error", async () => {
    mockVerifyState.mockReturnValue(null);
    const res = await GET(get("https://x.test/api/microsoft/callback?code=c&state=bad"));
    expect(new URL(res.headers.get("location")!).pathname).toBe("/");
  });

  test("token exchange failure redirects to /?ms=error", async () => {
    mockVerifyState.mockReturnValue("u1");
    mockExchangeCode.mockResolvedValue(null);
    const res = await GET(get("https://x.test/api/microsoft/callback?code=c&state=u1.sig"));
    expect(new URL(res.headers.get("location")!).pathname).toBe("/");
  });

  test("happy path with no returnTo redirects to /?ms=connected", async () => {
    mockVerifyState.mockReturnValue("u1");
    mockExchangeCode.mockResolvedValue({
      access_token: "a", refresh_token: "r", user_email: "", expires_at: "2030-01-01",
    });
    mockStoreTokens.mockResolvedValue(undefined);
    mockFetchUserProfile.mockResolvedValue({ email: "u@x", displayName: "U" });
    const res = await GET(get("https://x.test/api/microsoft/callback?code=c&state=u1.sig"));
    const u = new URL(res.headers.get("location")!);
    expect(u.pathname).toBe("/");
    expect(u.searchParams.get("ms")).toBe("connected");
  });

  test("happy path honors safe returnTo (e.g. /setup)", async () => {
    mockVerifyState.mockReturnValue("u1");
    mockExchangeCode.mockResolvedValue({
      access_token: "a", refresh_token: "r", user_email: "", expires_at: "2030-01-01",
    });
    mockStoreTokens.mockResolvedValue(undefined);
    mockFetchUserProfile.mockResolvedValue({ email: "u@x", displayName: "U" });
    const res = await GET(
      get("https://x.test/api/microsoft/callback?code=c&state=u1.sig&returnTo=%2Fsetup"),
    );
    expect(new URL(res.headers.get("location")!).pathname).toBe("/setup");
  });
});
