/**
 * Unit tests for the native TOTP / MFA core (src/lib/auth/mfa.ts).
 *
 * Security-critical: these prove the RFC 6238 verifier accepts only the right
 * codes within the right window, the constant-time path is exercised, the
 * secret is never persisted plaintext, and recovery codes are single-use.
 *
 * DB-touching functions (enroll/confirm/disable/verify-code) run in SHADOW mode
 * here (no DATABASE_URL) where appropriate, and against a mocked query() where
 * persistence behavior must be asserted.
 */

const mockQuery = jest.fn();
jest.mock("@/lib/db", () => ({
  query: (...a: unknown[]) => mockQuery(...a),
}));

import {
  generateSecret,
  totpForSecret,
  verifyTotp,
  constantTimeEquals,
  otpauthUrl,
  generateRecoveryCodes,
  hashRecoveryCode,
  base32Decode,
  base32Encode,
  enrollMfa,
  confirmMfa,
  verifyMfaCode,
} from "@/lib/auth/mfa";
import { encryptSecret } from "@/lib/crypto/secret-storage";

const STEP_MS = 30_000;

beforeEach(() => {
  mockQuery.mockReset();
  delete process.env.DATABASE_URL;
});

describe("base32 round-trip", () => {
  it("encodes then decodes back to the original bytes", () => {
    const buf = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 250, 255]);
    expect(base32Decode(base32Encode(buf)).equals(buf)).toBe(true);
  });
});

describe("verifyTotp (RFC 6238)", () => {
  const secret = "JBSWY3DPEHPK3PXP"; // canonical base32 test secret

  it("accepts a code generated for the current step", () => {
    const now = 1_700_000_000_000;
    const code = totpForSecret(secret, { atMs: now });
    expect(verifyTotp(secret, code, { atMs: now })).toBe(true);
  });

  it("accepts a code from the PREVIOUS step (clock skew -1)", () => {
    const now = 1_700_000_000_000;
    const prevCode = totpForSecret(secret, { atMs: now, stepOffset: -1 });
    expect(verifyTotp(secret, prevCode, { atMs: now })).toBe(true);
  });

  it("accepts a code from the NEXT step (clock skew +1)", () => {
    const now = 1_700_000_000_000;
    const nextCode = totpForSecret(secret, { atMs: now, stepOffset: 1 });
    expect(verifyTotp(secret, nextCode, { atMs: now })).toBe(true);
  });

  it("REJECTS a code two steps away (outside the +/-1 window)", () => {
    const now = 1_700_000_000_000;
    const farCode = totpForSecret(secret, { atMs: now, stepOffset: 2 });
    // Guard against the rare collision where two distant steps share a code.
    if (farCode !== totpForSecret(secret, { atMs: now })) {
      expect(verifyTotp(secret, farCode, { atMs: now })).toBe(false);
    }
  });

  it("REJECTS an expired/replayed code from far in the past", () => {
    const past = 1_700_000_000_000;
    const future = past + STEP_MS * 100; // ~50 minutes later
    const oldCode = totpForSecret(secret, { atMs: past });
    expect(verifyTotp(secret, oldCode, { atMs: future })).toBe(false);
  });

  it("REJECTS a clearly wrong code", () => {
    const now = 1_700_000_000_000;
    expect(verifyTotp(secret, "000000", { atMs: now })).toBe(false);
  });

  it("REJECTS non-6-digit input", () => {
    expect(verifyTotp(secret, "12345")).toBe(false);
    expect(verifyTotp(secret, "abcdef")).toBe(false);
    expect(verifyTotp(secret, "")).toBe(false);
  });
});

describe("constantTimeEquals", () => {
  it("is true for equal strings, false otherwise, and handles unequal lengths", () => {
    expect(constantTimeEquals("abc123", "abc123")).toBe(true);
    expect(constantTimeEquals("abc123", "abc124")).toBe(false);
    expect(constantTimeEquals("abc", "abcdef")).toBe(false);
  });
});

describe("otpauthUrl", () => {
  it("builds a valid otpauth:// URI carrying the secret + issuer", () => {
    const url = otpauthUrl({ secret: "JBSWY3DPEHPK3PXP", account: "cto@wolfpack.dev" });
    expect(url).toMatch(/^otpauth:\/\/totp\//);
    expect(url).toContain("secret=JBSWY3DPEHPK3PXP");
    expect(url).toContain("issuer=Wolfpack+Instinct");
    expect(url).toContain("digits=6");
    expect(url).toContain("period=30");
  });
});

describe("recovery codes", () => {
  it("generates the requested count of distinct codes", () => {
    const codes = generateRecoveryCodes(10);
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
  });

  it("hashRecoveryCode is stable, case/dash-insensitive, and one-way", () => {
    const code = "a1b2c-3d4e5";
    const h = hashRecoveryCode(code);
    expect(h).toBe(hashRecoveryCode("A1B2C3D4E5"));
    expect(h).toHaveLength(64); // sha256 hex
    expect(h).not.toContain(code);
  });
});

describe("enrollMfa — secret is NEVER persisted in plaintext", () => {
  it("stores an encrypted secret (ciphertext != plaintext) and returns the seed once", async () => {
    process.env.DATABASE_URL = "postgres://test";
    mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });

    const result = await enrollMfa({ userId: "u1", workspaceId: "w1", account: "u1@x.dev" });
    expect(result).not.toBeNull();
    const secret = result!.secret;
    expect(secret).toMatch(/^[A-Z2-7]+$/); // base32

    // Inspect what was written: the 4th param is the encrypted_secret.
    const insertCall = mockQuery.mock.calls.find((c) => /INSERT INTO instinct_admin_mfa/.test(c[0]));
    expect(insertCall).toBeTruthy();
    const storedSecret = insertCall![1][3] as string;
    expect(storedSecret).not.toBe(secret); // NOT plaintext
    expect(storedSecret).not.toContain(secret);
    expect(storedSecret.startsWith("v1.")).toBe(true); // AES-256-GCM token
  });
});

describe("confirmMfa", () => {
  const secret = "JBSWY3DPEHPK3PXP";

  function rowWith(confirmed: string | null, hashes: string[] = []) {
    return {
      id: "mfa_x",
      user_id: "u1",
      workspace_id: "w1",
      encrypted_secret: encryptSecret(secret),
      confirmed_at: confirmed,
      recovery_code_hashes: hashes,
    };
  }

  it("confirms with a valid code and returns recovery codes (shown once)", async () => {
    process.env.DATABASE_URL = "postgres://test";
    mockQuery
      .mockResolvedValueOnce({ rows: [rowWith(null)], rowCount: 1 }) // loadRow
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }); // UPDATE
    const code = totpForSecret(secret);
    const res = await confirmMfa({ userId: "u1", workspaceId: "w1", code });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.recoveryCodes.length).toBeGreaterThan(0);
  });

  it("rejects a bad code and writes nothing", async () => {
    process.env.DATABASE_URL = "postgres://test";
    mockQuery.mockResolvedValueOnce({ rows: [rowWith(null)], rowCount: 1 }); // loadRow only
    const res = await confirmMfa({ userId: "u1", workspaceId: "w1", code: "000000" });
    expect(res.ok).toBe(false);
    // Only the SELECT ran; no UPDATE.
    expect(mockQuery.mock.calls.some((c) => /UPDATE instinct_admin_mfa/.test(c[0]))).toBe(false);
  });

  it("returns no_enrollment when there is no row", async () => {
    process.env.DATABASE_URL = "postgres://test";
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const res = await confirmMfa({ userId: "u1", workspaceId: "w1", code: "123456" });
    expect(res.ok).toBe(false);
  });
});

describe("verifyMfaCode — recovery code consumed once then gone", () => {
  const secret = "JBSWY3DPEHPK3PXP";

  it("accepts a recovery code once and removes its hash", async () => {
    process.env.DATABASE_URL = "postgres://test";
    const recovery = "abcde-12345";
    const hashes = [hashRecoveryCode("zzzzz-99999"), hashRecoveryCode(recovery)];
    mockQuery
      .mockResolvedValueOnce({
        rows: [
          {
            id: "mfa_x",
            user_id: "u1",
            workspace_id: "w1",
            encrypted_secret: encryptSecret(secret),
            confirmed_at: new Date().toISOString(),
            recovery_code_hashes: hashes,
          },
        ],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }); // UPDATE removing the used hash

    const res = await verifyMfaCode({ userId: "u1", workspaceId: "w1", code: recovery });
    expect(res.ok).toBe(true);
    expect(res.usedRecoveryCode).toBe(true);

    const updateCall = mockQuery.mock.calls.find((c) => /UPDATE instinct_admin_mfa/.test(c[0]));
    expect(updateCall).toBeTruthy();
    const remaining = updateCall![1][2] as string[];
    expect(remaining).not.toContain(hashRecoveryCode(recovery));
    expect(remaining).toHaveLength(1);
  });

  it("accepts a current TOTP code without consuming a recovery code", async () => {
    process.env.DATABASE_URL = "postgres://test";
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "mfa_x",
          user_id: "u1",
          workspace_id: "w1",
          encrypted_secret: encryptSecret(secret),
          confirmed_at: new Date().toISOString(),
          recovery_code_hashes: [],
        },
      ],
      rowCount: 1,
    });
    const res = await verifyMfaCode({ userId: "u1", workspaceId: "w1", code: totpForSecret(secret) });
    expect(res.ok).toBe(true);
    expect(res.usedRecoveryCode).toBe(false);
  });
});

describe("generateSecret", () => {
  it("produces a fresh base32 secret each call", () => {
    expect(generateSecret()).not.toBe(generateSecret());
  });
});
