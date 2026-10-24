/** @jest-environment node */
/**
 * The admin MFA gate inside requireCapability, driven with real signed JWTs.
 *
 *   - an unenrolled admin is refused (403 mfa_required, mfa: "enroll") on any
 *     capability-gated route, but can still reach the MFA routes;
 *   - an enrolled admin needs this browser's proof; with it they pass;
 *   - a non-admin is unaffected (no enrollment read at all);
 *   - an operator-exempt account (CI smoke) passes and the use is reported;
 *   - a failed enrollment read is a 503, never a silent pass;
 *   - the kill switch restores the old behavior.
 */
const mockQuery = jest.fn();
const mockSafeQuery = jest.fn();
const mockTrack = jest.fn();

jest.mock("@/lib/db", () => ({
  query: (...a: unknown[]) => mockQuery(...a),
  safeQuery: (...a: unknown[]) => mockSafeQuery(...a),
}));
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: unknown[]) => mockTrack(...a) }));
jest.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
}));

process.env.INSTINCT_JWT_SECRET = "test-secret-for-mfa-gate-0123456789abcdef";

import { requireCapability } from "@/lib/auth/require-capability";
import { createToken } from "@/lib/auth";
import { issueMfaProof, MFA_PROOF_COOKIE } from "@/lib/crypto/mfa-proof";
import { encryptSecret } from "@/lib/crypto/secret-storage";

const CONFIRMED_AT = "2026-10-01T00:00:00.000Z";

function tokenFor(id: string, role: string, email: string): string {
  return createToken({ id, role, email, name: id, workspaceId: "w1", created_at: "" } as never);
}

function req(token: string, cookie?: string): Request {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (cookie) headers.cookie = cookie;
  return new Request("https://wp.test/api/admin/team", { headers });
}

/** instinct_admin_mfa read: none, or a confirmed enrollment. */
function enrollment(confirmed: boolean | "none") {
  mockQuery.mockImplementation(async (sql: string) => {
    if (/instinct_admin_mfa/.test(sql)) {
      if (confirmed === "none") return { rows: [] };
      return {
        rows: [
          {
            id: "m1",
            user_id: "u-cto",
            workspace_id: "w1",
            encrypted_secret: encryptSecret("JBSWY3DPEHPK3PXP"),
            confirmed_at: confirmed ? CONFIRMED_AT : null,
            recovery_code_hashes: [],
          },
        ],
      };
    }
    return { rows: [] };
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.DATABASE_URL = "postgres://test";
  delete process.env.MFA_ENFORCE_ADMIN;
  delete process.env.MFA_EXEMPT_EMAILS;
  // No overrides row: capabilities come from the JWT role.
  mockSafeQuery.mockResolvedValue({ rows: [] });
});

describe("admin MFA gate", () => {
  it("refuses an unenrolled admin with mfa=enroll and reports it", async () => {
    enrollment("none");
    const r = await requireCapability(req(tokenFor("u-cto", "cto", "cto@example.test")), "settings.manage_team");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.response.status).toBe(403);
    expect(await r.response.json()).toMatchObject({ error: "mfa_required", mfa: "enroll" });
    expect(mockTrack).toHaveBeenCalledWith(
      "auth.mfa_enforcement_blocked",
      "u-cto",
      "cto",
      expect.objectContaining({ reason: "enroll", capability: "settings.manage_team" }),
    );
  });

  it("applies to every capability an admin calls, not only admin ones", async () => {
    enrollment("none");
    const r = await requireCapability(req(tokenFor("u-cto", "cto", "cto@example.test")), "assistant.use");
    expect(r.ok).toBe(false);
  });

  it("always lets an admin reach the MFA routes so they can enroll", async () => {
    enrollment("none");
    const r = await requireCapability(req(tokenFor("u-cto", "cto", "cto@example.test")), "account.manage_mfa");
    expect(r.ok).toBe(true);
  });

  it("asks an enrolled admin without a proof to answer a challenge", async () => {
    enrollment(true);
    const r = await requireCapability(req(tokenFor("u-cto", "cto", "cto@example.test")), "settings.manage_team");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(await r.response.json()).toMatchObject({ error: "mfa_required", mfa: "challenge" });
  });

  it("passes an enrolled admin holding this browser's proof", async () => {
    enrollment(true);
    const proof = issueMfaProof({ userId: "u-cto", confirmedAtMs: Date.parse(CONFIRMED_AT) });
    const r = await requireCapability(
      req(tokenFor("u-cto", "cto", "cto@example.test"), `${MFA_PROOF_COOKIE}=${encodeURIComponent(proof)}`),
      "settings.manage_team",
    );
    expect(r.ok).toBe(true);
  });

  it("refuses another user's proof", async () => {
    enrollment(true);
    const proof = issueMfaProof({ userId: "someone-else", confirmedAtMs: Date.parse(CONFIRMED_AT) });
    const r = await requireCapability(
      req(tokenFor("u-cto", "cto", "cto@example.test"), `${MFA_PROOF_COOKIE}=${encodeURIComponent(proof)}`),
      "settings.manage_team",
    );
    expect(r.ok).toBe(false);
  });

  it("leaves a non-admin unaffected and never reads the enrollment", async () => {
    enrollment("none");
    const r = await requireCapability(req(tokenFor("u-sales", "sales", "sales@example.test")), "account.manage_mfa");
    expect(r.ok).toBe(true);
    const mfaReads = mockQuery.mock.calls.filter((c) => /instinct_admin_mfa/.test(String(c[0])));
    expect(mfaReads).toHaveLength(0);
  });

  it("keeps the plain 403 for a missing capability (gate runs after the capability check)", async () => {
    enrollment("none");
    const r = await requireCapability(req(tokenFor("u-sales", "sales", "sales@example.test")), "settings.manage_team");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(await r.response.json()).toMatchObject({ error: "forbidden" });
  });

  it("lets an operator-exempt CI account through and reports the exemption", async () => {
    process.env.MFA_EXEMPT_EMAILS = "smoke@example.test";
    enrollment("none");
    const r = await requireCapability(req(tokenFor("u-smoke", "cto", "smoke@example.test")), "settings.manage_team");
    expect(r.ok).toBe(true);
    expect(mockTrack).toHaveBeenCalledWith("auth.mfa_exemption_applied", "u-smoke", "cto", expect.any(Object));
  });

  it("returns 503 when the enrollment cannot be read", async () => {
    mockQuery.mockRejectedValue(new Error("connection terminated"));
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
    const r = await requireCapability(req(tokenFor("u-cto", "cto", "cto@example.test")), "settings.manage_team");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.response.status).toBe(503);
  });

  it("MFA_ENFORCE_ADMIN=off restores the previous behavior", async () => {
    process.env.MFA_ENFORCE_ADMIN = "off";
    enrollment("none");
    const r = await requireCapability(req(tokenFor("u-cto", "cto", "cto@example.test")), "settings.manage_team");
    expect(r.ok).toBe(true);
  });

  it("401 is unchanged for an anonymous caller", async () => {
    const r = await requireCapability(new Request("https://wp.test/api/admin/team"), "settings.manage_team");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.response.status).toBe(401);
  });
});
