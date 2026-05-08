/**
 * Contract tests for /api/auth/forgot-password.
 *
 * Locks in:
 *   - 400 on missing/invalid email
 *   - 200 generic body even when email is unknown (no enumeration leak)
 *   - 200 happy path: row written, mailer called with the right args
 *   - 429 after 5 attempts in the rolling window from the same IP
 *   - dev_link surfaced ONLY when delivery failed (no_api_key path)
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export {};

const mockSafeQuery = jest.fn();
jest.mock("@/lib/db", () => ({ safeQuery: (...a: any[]) => mockSafeQuery(...a) }));

const mockTrackEvent: jest.Mock = jest.fn();
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: any[]) => mockTrackEvent(...a) }));

function mkReq(body: unknown, ip = "1.1.1.1"): any {
  return {
    json: async () => body,
    headers: new Headers({ "x-forwarded-for": ip, "user-agent": "jest" }),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.resetModules();
  mockSafeQuery.mockResolvedValue({ rows: [], fromCache: false });
});

describe("POST /api/auth/forgot-password (forgotFlow)", () => {
  it("400 on missing email", async () => {
    const { forgotFlow, _resetRateLimit } = await import("@/app/api/auth/forgot-password/route");
    _resetRateLimit();
    const res = await forgotFlow(mkReq({}));
    expect(res.status).toBe(400);
  });

  it("400 on email without @", async () => {
    const { forgotFlow, _resetRateLimit } = await import("@/app/api/auth/forgot-password/route");
    _resetRateLimit();
    const res = await forgotFlow(mkReq({ email: "nope" }));
    expect(res.status).toBe(400);
  });

  it("200 with generic body when email is unknown (no enumeration leak)", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [], fromCache: false });
    const { forgotFlow, _resetRateLimit } = await import("@/app/api/auth/forgot-password/route");
    _resetRateLimit();
    const res = await forgotFlow(mkReq({ email: "ghost@example.com" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
    // Insert should NOT have happened — only the SELECT.
    expect(mockSafeQuery).toHaveBeenCalledTimes(1);
  });

  it("200 happy path: writes row, calls mailer with reset URL, no dev_link in response", async () => {
    mockSafeQuery
      .mockResolvedValueOnce({
        rows: [{ id: "tm_1", email: "max@thewolfpack.agency", name: "Max" }],
        fromCache: false,
      })
      .mockResolvedValueOnce({ rows: [], fromCache: false });

    const mailer = jest.fn().mockResolvedValue({ delivered: true, reason: "ok" });
    const { forgotFlow, _resetRateLimit } = await import("@/app/api/auth/forgot-password/route");
    _resetRateLimit();
    const res = await forgotFlow(mkReq({ email: "max@thewolfpack.agency" }), { mailer });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.dev_link).toBeUndefined();

    // INSERT into instinct_password_resets ran after the SELECT.
    expect(mockSafeQuery).toHaveBeenCalledTimes(2);
    expect(mockSafeQuery.mock.calls[1][0]).toMatch(/INSERT INTO instinct_password_resets/);
    expect(mailer).toHaveBeenCalledTimes(1);
    expect(mailer.mock.calls[0][0].to).toBe("max@thewolfpack.agency");
    expect(mailer.mock.calls[0][0].resetUrl).toContain("/reset-password?token=");
  });

  it("200 surfaces dev_link when mailer reports no_api_key", async () => {
    mockSafeQuery
      .mockResolvedValueOnce({
        rows: [{ id: "tm_1", email: "max@thewolfpack.agency", name: "Max" }],
        fromCache: false,
      })
      .mockResolvedValueOnce({ rows: [], fromCache: false });

    const mailer = jest.fn().mockResolvedValue({ delivered: false, reason: "no_api_key" });
    const { forgotFlow, _resetRateLimit } = await import("@/app/api/auth/forgot-password/route");
    _resetRateLimit();
    const res = await forgotFlow(mkReq({ email: "max@thewolfpack.agency" }), { mailer });
    const body = await res.json();
    expect(body.dev_link).toContain("/reset-password?token=");
    expect(body.email_reason).toBe("no_api_key");
  });

  it("429 after 5 attempts in the rolling window from the same IP", async () => {
    const { forgotFlow, _resetRateLimit } = await import("@/app/api/auth/forgot-password/route");
    _resetRateLimit();

    for (let i = 0; i < 5; i++) {
      const res = await forgotFlow(mkReq({ email: "ghost@example.com" }, "9.9.9.9"));
      expect(res.status).toBe(200);
    }
    const res6 = await forgotFlow(mkReq({ email: "ghost@example.com" }, "9.9.9.9"));
    expect(res6.status).toBe(429);
  });

  it("shadow mode (no DB): generic 200, no mailer", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [], fromCache: true });
    const mailer = jest.fn();
    const { forgotFlow, _resetRateLimit } = await import("@/app/api/auth/forgot-password/route");
    _resetRateLimit();
    const res = await forgotFlow(mkReq({ email: "any@ex.com" }), { mailer });
    expect(res.status).toBe(200);
    expect(mailer).not.toHaveBeenCalled();
  });
});
