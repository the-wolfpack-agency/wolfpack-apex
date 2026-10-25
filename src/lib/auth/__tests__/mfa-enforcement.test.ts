/** @jest-environment node */
/**
 * The admin MFA ENFORCEMENT policy (src/lib/auth/mfa.ts) and the sealed
 * "this browser passed MFA" proof (src/lib/crypto/mfa-proof.ts).
 *
 * Who is enforced, who is exempt, what an admin must do next, and that a proof
 * cannot be forged, moved to another user, outlive its enrollment, or expire
 * late. The DB read is mocked; mfa-enforcement-route.test.ts covers the gate
 * inside requireCapability.
 */
const mockQuery = jest.fn();
jest.mock("@/lib/db", () => ({ query: (...a: unknown[]) => mockQuery(...a) }));

import {
  mfaEnforcementEnabled,
  isMfaExempt,
  mfaRequirementFor,
  canChangeEnrollment,
  mfaChallengeLocked,
  recordMfaFailure,
  clearMfaFailures,
  __resetMfaFailuresForTests,
  readCookie,
  MFA_ADMIN_CAPABILITY,
  MFA_MAX_FAILURES,
  MFA_FAILURE_WINDOW_SECONDS,
  totpForSecret,
} from "@/lib/auth/mfa";
import { issueMfaProof, verifyMfaProof } from "@/lib/crypto/mfa-proof";
import { encryptSecret } from "@/lib/crypto/secret-storage";
import { mfaRedirectFor, safeNextPath } from "@/lib/auth/mfa-client";

const ADMIN_CAPS = new Set<string>([MFA_ADMIN_CAPABILITY, "account.manage_mfa"]);
const MEMBER_CAPS = new Set<string>(["account.manage_mfa", "assistant.use"]);
const CONFIRMED_AT = "2026-10-01T00:00:00.000Z";
const CONFIRMED_MS = Date.parse(CONFIRMED_AT);
const ADMIN = { id: "u-admin", email: "cto@example.test", workspaceId: "w1" };

function enrollmentRow(confirmed: boolean, secret = "JBSWY3DPEHPK3PXP") {
  return {
    rows: [
      {
        id: "m1",
        user_id: ADMIN.id,
        workspace_id: "w1",
        encrypted_secret: encryptSecret(secret),
        confirmed_at: confirmed ? CONFIRMED_AT : null,
        recovery_code_hashes: [],
      },
    ],
  };
}

beforeEach(() => {
  mockQuery.mockReset();
  process.env.DATABASE_URL = "postgres://test";
  delete process.env.MFA_ENFORCE_ADMIN;
  delete process.env.MFA_EXEMPT_EMAILS;
  __resetMfaFailuresForTests();
});

describe("mfaEnforcementEnabled (default ON)", () => {
  it.each([[undefined, true], ["", true], ["on", true], ["true", true], ["off", false], ["false", false], ["0", false], [" OFF ", false]])(
    "MFA_ENFORCE_ADMIN=%p -> %p",
    (v, expected) => {
      expect(mfaEnforcementEnabled(v === undefined ? ({} as unknown as NodeJS.ProcessEnv) : ({ MFA_ENFORCE_ADMIN: v } as unknown as NodeJS.ProcessEnv))).toBe(expected);
    },
  );
});

describe("isMfaExempt", () => {
  it("matches the operator list case-insensitively, trimming spaces", () => {
    const env = { MFA_EXEMPT_EMAILS: " Smoke@Example.test , other@example.test" } as unknown as NodeJS.ProcessEnv;
    expect(isMfaExempt("smoke@example.test", env)).toBe(true);
    expect(isMfaExempt("OTHER@example.test", env)).toBe(true);
    expect(isMfaExempt("cto@example.test", env)).toBe(false);
  });
  it("is never true for an empty list or an empty email", () => {
    expect(isMfaExempt("a@example.test", ({} as unknown as NodeJS.ProcessEnv))).toBe(false);
    expect(isMfaExempt("", { MFA_EXEMPT_EMAILS: "," } as unknown as NodeJS.ProcessEnv)).toBe(false);
  });
});

describe("mfaRequirementFor", () => {
  it("a non-admin is never a subject and never reads the enrollment", async () => {
    const d = await mfaRequirementFor({ user: { id: "u-sales" }, capabilities: MEMBER_CAPS });
    expect(d).toEqual({ required: null, exempt: false, subject: false });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("an admin with no enrollment must enroll (the grace path: sent to enrollment, not locked out)", async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    const d = await mfaRequirementFor({ user: ADMIN, capabilities: ADMIN_CAPS });
    expect(d).toEqual({ required: "enroll", exempt: false, subject: true });
  });

  it("an admin with a started but unconfirmed enrollment must still enroll", async () => {
    mockQuery.mockResolvedValue(enrollmentRow(false));
    expect((await mfaRequirementFor({ user: ADMIN, capabilities: ADMIN_CAPS })).required).toBe("enroll");
  });

  it("an enrolled admin without a proof must answer a challenge", async () => {
    mockQuery.mockResolvedValue(enrollmentRow(true));
    expect((await mfaRequirementFor({ user: ADMIN, capabilities: ADMIN_CAPS })).required).toBe("challenge");
  });

  it("an enrolled admin with a valid proof passes", async () => {
    mockQuery.mockResolvedValue(enrollmentRow(true));
    const proof = issueMfaProof({ userId: ADMIN.id, confirmedAtMs: CONFIRMED_MS });
    const d = await mfaRequirementFor({ user: ADMIN, capabilities: ADMIN_CAPS, proofToken: proof });
    expect(d).toEqual({ required: null, exempt: false, subject: true });
  });

  it("an exempt admin passes without a DB read", async () => {
    process.env.MFA_EXEMPT_EMAILS = "cto@example.test";
    const d = await mfaRequirementFor({ user: ADMIN, capabilities: ADMIN_CAPS });
    expect(d).toEqual({ required: null, exempt: true, subject: true });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("the kill switch turns enforcement off", async () => {
    process.env.MFA_ENFORCE_ADMIN = "off";
    expect((await mfaRequirementFor({ user: ADMIN, capabilities: ADMIN_CAPS })).required).toBeNull();
  });

  it("an on-behalf delegation token is not challenged (an agent cannot answer a TOTP)", async () => {
    const d = await mfaRequirementFor({ user: { ...ADMIN, actingAgentId: "agent-1" }, capabilities: ADMIN_CAPS });
    expect(d.required).toBeNull();
  });

  it("shadow mode (no database) does not enforce", async () => {
    delete process.env.DATABASE_URL;
    expect((await mfaRequirementFor({ user: ADMIN, capabilities: ADMIN_CAPS })).required).toBeNull();
  });

  it("a failed enrollment read is 'unavailable', never a silent pass", async () => {
    mockQuery.mockRejectedValue(new Error("connection terminated"));
    expect((await mfaRequirementFor({ user: ADMIN, capabilities: ADMIN_CAPS })).required).toBe("unavailable");
  });
});

describe("mfa proof", () => {
  const userId = "u1";
  it("verifies for the same user and enrollment", () => {
    expect(verifyMfaProof(issueMfaProof({ userId, confirmedAtMs: 1 }), { userId, confirmedAtMs: 1 })).toBe(true);
  });
  it("is rejected for another user", () => {
    expect(verifyMfaProof(issueMfaProof({ userId, confirmedAtMs: 1 }), { userId: "u2", confirmedAtMs: 1 })).toBe(false);
  });
  it("is rejected after re-enrollment (confirmed_at changed)", () => {
    expect(verifyMfaProof(issueMfaProof({ userId, confirmedAtMs: 1 }), { userId, confirmedAtMs: 2 })).toBe(false);
  });
  it("expires", () => {
    const p = issueMfaProof({ userId, confirmedAtMs: 1, nowMs: 0, ttlSeconds: 10 });
    expect(verifyMfaProof(p, { userId, confirmedAtMs: 1, nowMs: 9_000 })).toBe(true);
    expect(verifyMfaProof(p, { userId, confirmedAtMs: 1, nowMs: 10_000 })).toBe(false);
  });
  it("cannot be forged: tampered, garbage, or another sealed value with the wrong purpose", () => {
    const p = issueMfaProof({ userId, confirmedAtMs: 1 });
    const parts = p.split(".");
    const ct = Buffer.from(parts[3], "base64");
    ct[0] ^= 1;
    parts[3] = ct.toString("base64");
    expect(verifyMfaProof(parts.join("."), { userId, confirmedAtMs: 1 })).toBe(false);
    expect(verifyMfaProof("v1.x.y.z", { userId, confirmedAtMs: 1 })).toBe(false);
    expect(verifyMfaProof(null, { userId, confirmedAtMs: 1 })).toBe(false);
    const wrongPurpose = encryptSecret(JSON.stringify({ p: "other", u: userId, c: 1, e: Date.now() + 1e6 }));
    expect(verifyMfaProof(wrongPurpose, { userId, confirmedAtMs: 1 })).toBe(false);
  });
});

describe("canChangeEnrollment (step-up before disable / re-enroll)", () => {
  it("allows changes when nothing is confirmed", async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await expect(canChangeEnrollment({ userId: ADMIN.id, workspaceId: "w1" })).resolves.toEqual({ ok: true });
  });
  it("requires a code when confirmed and no proof is presented", async () => {
    mockQuery.mockResolvedValue(enrollmentRow(true));
    await expect(canChangeEnrollment({ userId: ADMIN.id, workspaceId: "w1" })).resolves.toEqual({
      ok: false,
      reason: "mfa_code_required",
    });
  });
  it("accepts a valid proof from this browser", async () => {
    mockQuery.mockResolvedValue(enrollmentRow(true));
    const proofToken = issueMfaProof({ userId: ADMIN.id, confirmedAtMs: CONFIRMED_MS });
    await expect(canChangeEnrollment({ userId: ADMIN.id, workspaceId: "w1", proofToken })).resolves.toEqual({ ok: true });
  });
  it("accepts a current TOTP and refuses a wrong one", async () => {
    mockQuery.mockResolvedValue(enrollmentRow(true));
    const good = totpForSecret("JBSWY3DPEHPK3PXP");
    await expect(canChangeEnrollment({ userId: ADMIN.id, workspaceId: "w1", code: good })).resolves.toEqual({ ok: true });
    const bad = good === "000000" ? "111111" : "000000";
    await expect(canChangeEnrollment({ userId: ADMIN.id, workspaceId: "w1", code: bad })).resolves.toEqual({
      ok: false,
      reason: "bad_code",
    });
  });
});

describe("challenge failure limiter", () => {
  it(`locks after ${MFA_MAX_FAILURES} failures and unlocks after the window`, () => {
    const t0 = 1_000_000;
    for (let i = 0; i < MFA_MAX_FAILURES - 1; i++) recordMfaFailure("u", t0);
    expect(mfaChallengeLocked("u", t0)).toBe(false);
    recordMfaFailure("u", t0);
    expect(mfaChallengeLocked("u", t0)).toBe(true);
    expect(mfaChallengeLocked("u", t0 + MFA_FAILURE_WINDOW_SECONDS * 1000)).toBe(false);
  });
  it("is per user and cleared by a success", () => {
    for (let i = 0; i < MFA_MAX_FAILURES; i++) recordMfaFailure("a");
    expect(mfaChallengeLocked("a")).toBe(true);
    expect(mfaChallengeLocked("b")).toBe(false);
    clearMfaFailures("a");
    expect(mfaChallengeLocked("a")).toBe(false);
  });
});

describe("readCookie", () => {
  it("reads one cookie out of a header", () => {
    const req = new Request("https://x.test", { headers: { cookie: "a=1; instinct_mfa_proof=v1.abc%3D; b=2" } });
    expect(readCookie(req, "instinct_mfa_proof")).toBe("v1.abc=");
    expect(readCookie(req, "missing")).toBeNull();
    expect(readCookie(new Request("https://x.test"), "a")).toBeNull();
  });
});

describe("mfa-client redirect helpers", () => {
  it("sends enroll / challenge to /mfa with a safe next, and nothing else anywhere", () => {
    expect(mfaRedirectFor("enroll", "/admin/team")).toBe("/mfa?next=%2Fadmin%2Fteam");
    expect(mfaRedirectFor("challenge", "/")).toBe("/mfa");
    expect(mfaRedirectFor(null, "/admin")).toBeNull();
    expect(mfaRedirectFor("unavailable", "/admin")).toBeNull();
    expect(mfaRedirectFor(undefined, "/admin")).toBeNull();
  });
  it("refuses open redirects and loops", () => {
    expect(safeNextPath("https://evil.test")).toBe("/");
    expect(safeNextPath("//evil.test")).toBe("/");
    expect(safeNextPath("/\\evil.test")).toBe("/");
    expect(safeNextPath("/mfa?next=/x")).toBe("/");
    expect(safeNextPath(null)).toBe("/");
    expect(safeNextPath("/settings#mfa")).toBe("/settings#mfa");
  });
});
