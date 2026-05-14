/**
 * API: POST /api/team/invite/resend.
 *
 * Covers:
 *   - 401 when caller lacks the manage_team capability
 *   - 400 on missing / malformed body
 *   - 404 when no invite exists for the email
 *   - 409 when invite is already accepted
 *   - 200 happy path: expires_at extended + sendInviteEmail called +
 *     analytics + audit fired
 */

const mockRequireCapability = jest.fn();
jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: (...a: any[]) => mockRequireCapability(...a),
}));

const mockSafeQuery = jest.fn();
jest.mock("@/lib/db", () => ({
  safeQuery: (...a: any[]) => mockSafeQuery(...a),
}));

const mockTrack = jest.fn();
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: any[]) => mockTrack(...a),
}));

const mockRecordAudit = jest.fn().mockResolvedValue(undefined);
jest.mock("@/lib/audit-log", () => ({
  recordAudit: (...a: any[]) => mockRecordAudit(...a),
  extractRequestMetadata: () => ({ ipAddress: "1.1.1.1", userAgent: "j", requestId: "r" }),
}));

const mockSendInviteEmail = jest.fn();
jest.mock("@/lib/mail/send-invite", () => ({
  sendInviteEmail: (...a: any[]) => mockSendInviteEmail(...a),
  buildAcceptUrl: (t: string) => `https://x/accept?token=${t}`,
}));

import { resendFlow } from "@/app/api/team/invite/resend/route";

function mkReq(body: unknown): any {
  return {
    json: async () => body,
    headers: new Map(),
  } as any;
}

const ADMIN_USER = { id: "u1", email: "homyk@thewolfpack.agency", role: "cto" };

beforeEach(() => {
  jest.clearAllMocks();
});

describe("POST /api/team/invite/resend", () => {
  test("401 when caller lacks settings.manage_team", async () => {
    mockRequireCapability.mockResolvedValue({
      ok: false,
      response: { status: 401 } as any,
    });
    const res = await resendFlow(mkReq({ email: "max@thewolfpack.agency" }));
    expect((res as any).status).toBe(401);
  });

  test("400 when email is missing or malformed", async () => {
    mockRequireCapability.mockResolvedValue({ ok: true, user: ADMIN_USER });
    const res = await resendFlow(mkReq({}));
    expect(res.status).toBe(400);
  });

  test("404 when no invite exists for that email", async () => {
    mockRequireCapability.mockResolvedValue({ ok: true, user: ADMIN_USER });
    mockSafeQuery.mockResolvedValueOnce({ rows: [], fromCache: false });
    const res = await resendFlow(mkReq({ email: "ghost@thewolfpack.agency" }));
    expect(res.status).toBe(404);
  });

  test("409 when invite is already accepted", async () => {
    mockRequireCapability.mockResolvedValue({ ok: true, user: ADMIN_USER });
    mockSafeQuery.mockResolvedValueOnce({
      rows: [{ id: "inv-1", email: "max@x", role: "evp", token: "t", status: "accepted" }],
      fromCache: false,
    });
    const res = await resendFlow(mkReq({ email: "max@thewolfpack.agency" }));
    expect(res.status).toBe(409);
  });

  test("200 happy path: extends expiry + re-sends email + analytics + audit", async () => {
    mockRequireCapability.mockResolvedValue({ ok: true, user: ADMIN_USER });
    /* 1st call: SELECT existing invite */
    mockSafeQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "inv-max",
          email: "max@thewolfpack.agency",
          role: "evp",
          token: "tok-abc",
          status: "pending",
        },
      ],
      fromCache: false,
    });
    /* 2nd call: UPDATE returns new expires_at */
    const newExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    mockSafeQuery.mockResolvedValueOnce({
      rows: [{ expires_at: newExpiry }],
      fromCache: false,
    });
    mockSendInviteEmail.mockResolvedValueOnce({ delivered: true, reason: "ok" });

    const res = await resendFlow(mkReq({ email: "max@thewolfpack.agency" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe("inv-max");
    expect(body.email).toBe("max@thewolfpack.agency");
    expect(body.acceptUrl).toContain("tok-abc");
    expect(body.emailDelivered).toBe(true);

    /* Email actually got called with the right shape */
    expect(mockSendInviteEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "max@thewolfpack.agency",
        role: "evp",
        acceptUrl: expect.stringContaining("tok-abc"),
      }),
    );

    expect(mockTrack).toHaveBeenCalledWith(
      "system.team_invite_resent",
      "u1",
      "cto",
      expect.objectContaining({
        invite_id: "inv-max",
        invited_email: "max@thewolfpack.agency",
        extension_days: 30,
        email_delivered: true,
      }),
    );

    expect(mockRecordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "team.invite.resent",
        resourceType: "team_invite",
        resourceId: "inv-max",
      }),
    );
  });

  test("200 even when email provider fails — invite is still extended (no rollback)", async () => {
    mockRequireCapability.mockResolvedValue({ ok: true, user: ADMIN_USER });
    mockSafeQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "inv-1",
          email: "a@x",
          role: "dev",
          token: "t",
          status: "pending",
        },
      ],
      fromCache: false,
    });
    mockSafeQuery.mockResolvedValueOnce({
      rows: [{ expires_at: new Date().toISOString() }],
      fromCache: false,
    });
    mockSendInviteEmail.mockRejectedValueOnce(new Error("Resend 500"));

    const res = await resendFlow(mkReq({ email: "a@x" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.emailDelivered).toBe(false);
  });
});
