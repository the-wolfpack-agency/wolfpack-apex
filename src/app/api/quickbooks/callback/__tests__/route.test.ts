 
/**
 * /api/quickbooks/callback redirect contract.
 *
 * Dashboard home is "/" (Next route group (dashboard) mounts there).
 * Callback must not redirect to "/dashboard" — that path 404s.
 */

const mockExchangeCode = jest.fn();
const mockStoreTokens = jest.fn();
const mockFetchCompanyInfo = jest.fn();
const mockClearCache = jest.fn();

jest.mock("@/lib/quickbooks", () => ({
  exchangeCode: (...a: any[]) => mockExchangeCode(...a),
  storeTokens: (...a: any[]) => mockStoreTokens(...a),
  fetchCompanyInfo: (...a: any[]) => mockFetchCompanyInfo(...a),
  clearCache: (...a: any[]) => mockClearCache(...a),
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
  mockFetchCompanyInfo.mockReset();
  mockClearCache.mockReset();
});

describe("quickbooks callback redirects to / (dashboard route group root)", () => {
  test("error=access_denied redirects to /?qbo=denied (not /dashboard)", async () => {
    const res = await GET(get("https://x.test/api/quickbooks/callback?error=access_denied"));
    const u = new URL(res.headers.get("location")!);
    expect(u.pathname).toBe("/");
    expect(u.searchParams.get("qbo")).toBe("denied");
  });

  test("missing code or realmId redirects to /?qbo=error", async () => {
    const res = await GET(get("https://x.test/api/quickbooks/callback?code=c"));
    expect(new URL(res.headers.get("location")!).pathname).toBe("/");
  });

  test("token exchange failure redirects to /?qbo=error", async () => {
    mockExchangeCode.mockResolvedValue(null);
    const res = await GET(get("https://x.test/api/quickbooks/callback?code=c&realmId=r1"));
    expect(new URL(res.headers.get("location")!).pathname).toBe("/");
  });

  test("happy path with no returnTo redirects to /?qbo=connected", async () => {
    mockExchangeCode.mockResolvedValue({
      access_token: "a", refresh_token: "r", realm_id: "r1", expires_at: "2030-01-01",
    });
    mockStoreTokens.mockResolvedValue(undefined);
    mockFetchCompanyInfo.mockResolvedValue({ companyName: "Acme" });
    const res = await GET(get("https://x.test/api/quickbooks/callback?code=c&realmId=r1"));
    const u = new URL(res.headers.get("location")!);
    expect(u.pathname).toBe("/");
    expect(u.searchParams.get("qbo")).toBe("connected");
  });
});
