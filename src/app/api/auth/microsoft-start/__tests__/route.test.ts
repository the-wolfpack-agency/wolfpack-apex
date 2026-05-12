 
const mockGetSigninAuthUrl = jest.fn();
const mockTrack = jest.fn();

jest.mock("@/lib/microsoft-graph", () => ({
  getSigninAuthUrl: (...a: any[]) => mockGetSigninAuthUrl(...a),
}));
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: any[]) => mockTrack(...a),
}));

import { GET } from "../route";

beforeEach(() => {
  mockGetSigninAuthUrl.mockReset();
  mockTrack.mockReset();
});

describe("GET /api/auth/microsoft-start", () => {
  test("returns the auth URL when MS env vars are configured", async () => {
    mockGetSigninAuthUrl.mockReturnValueOnce(
      "https://login.microsoftonline.com/x/oauth2/v2.0/authorize?client_id=abc",
    );
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.authUrl).toContain("https://login.microsoftonline.com");
    expect(mockTrack).toHaveBeenCalledWith(
      "system.microsoft_signin_started",
      "anonymous",
      "anonymous",
      expect.any(Object),
    );
  });

  test("503 when MS env vars are missing (so /login can fall back gracefully)", async () => {
    mockGetSigninAuthUrl.mockReturnValueOnce("");
    const res = await GET();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("microsoft_signin_not_configured");
  });
});
