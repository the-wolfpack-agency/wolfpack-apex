/** @jest-environment node */
/**
 * At-rest sealing for Microsoft Graph tokens (graph-token-storage.ts) and the
 * pure backfill planner (graph-token-backfill.ts).
 *
 * Pins the four properties the security review asked for: a round trip works,
 * a legacy plaintext row still reads (deploy day), a tampered or wrong-key row
 * is refused rather than treated as plaintext, and a sealed value never
 * contains the token.
 */
import {
  GraphTokenSealError,
  isSealedToken,
  openGraphToken,
  sealGraphToken,
} from "@/lib/crypto/graph-token-storage";
import { checkKey, planBackfill } from "@/lib/crypto/graph-token-backfill";
import { __resetSecretKeyCacheForTests } from "@/lib/crypto/secret-storage";

const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);
const ACCESS = "eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.payload.signature";
const REFRESH = "0.AXkAexample-refresh-token-value";

function useKey(hex: string): void {
  process.env.INSTINCT_SECRET_KEY = hex;
  __resetSecretKeyCacheForTests();
}

beforeEach(() => useKey(KEY_A));
afterAll(() => {
  delete process.env.INSTINCT_SECRET_KEY;
  __resetSecretKeyCacheForTests();
});

describe("sealGraphToken / openGraphToken", () => {
  it("round-trips a token", () => {
    const sealed = sealGraphToken(ACCESS);
    expect(isSealedToken(sealed)).toBe(true);
    expect(openGraphToken(sealed)).toEqual({ ok: true, value: ACCESS, format: "sealed" });
  });

  it("never returns the plaintext, or any recognisable part of it", () => {
    const sealed = sealGraphToken(ACCESS);
    expect(sealed).not.toContain(ACCESS);
    expect(sealed).not.toContain("payload");
    expect(sealed.startsWith("v1.")).toBe(true);
  });

  it("seals the same token differently each time (random IV)", () => {
    expect(sealGraphToken(REFRESH)).not.toBe(sealGraphToken(REFRESH));
  });

  it("reads a legacy raw plaintext row and says it is legacy", () => {
    expect(openGraphToken(ACCESS)).toEqual({ ok: true, value: ACCESS, format: "legacy_plaintext" });
    expect(openGraphToken(REFRESH)).toEqual({ ok: true, value: REFRESH, format: "legacy_plaintext" });
  });

  it("reads the secret-storage 'plain.' fallback envelope as legacy (it is not encrypted)", () => {
    const envelope = `plain.${Buffer.from(REFRESH, "utf8").toString("base64")}`;
    expect(openGraphToken(envelope)).toEqual({ ok: true, value: REFRESH, format: "legacy_plaintext" });
  });

  it("reports empty values as empty, not as a token", () => {
    expect(openGraphToken(null)).toEqual({ ok: true, value: null, format: "empty" });
    expect(openGraphToken("")).toEqual({ ok: true, value: null, format: "empty" });
    expect(openGraphToken(undefined)).toEqual({ ok: true, value: null, format: "empty" });
  });

  it("detects a tampered ciphertext and refuses it (never falls back to plaintext)", () => {
    const sealed = sealGraphToken(ACCESS);
    const [prefix, iv, tag, ct] = sealed.split(".");
    const flipped = Buffer.from(ct, "base64");
    flipped[0] = flipped[0] ^ 0xff;
    const tampered = [prefix, iv, tag, flipped.toString("base64")].join(".");
    expect(openGraphToken(tampered)).toEqual({ ok: false, reason: "tampered_or_wrong_key" });
  });

  it("detects a tampered auth tag", () => {
    const sealed = sealGraphToken(ACCESS);
    const parts = sealed.split(".");
    const tag = Buffer.from(parts[2], "base64");
    tag[3] = tag[3] ^ 0x01;
    parts[2] = tag.toString("base64");
    expect(openGraphToken(parts.join(".")).ok).toBe(false);
  });

  it("refuses a value sealed under a different key", () => {
    const sealed = sealGraphToken(ACCESS);
    useKey(KEY_B);
    expect(openGraphToken(sealed)).toEqual({ ok: false, reason: "tampered_or_wrong_key" });
  });

  it("refuses a malformed v1 envelope", () => {
    expect(openGraphToken("v1.not-an-envelope").ok).toBe(false);
  });

  it("throws instead of sealing an empty token, and the error never carries a token", () => {
    expect(() => sealGraphToken("")).toThrow(GraphTokenSealError);
    try {
      sealGraphToken("");
    } catch (err) {
      expect((err as Error).message).not.toContain(ACCESS);
    }
  });
});

describe("planBackfill", () => {
  it("plans a sealed rewrite for legacy rows and skips rows already sealed", () => {
    const sealedRow = {
      connected_by: "u-sealed",
      user_email: "s@example.test",
      access_token: sealGraphToken(ACCESS),
      refresh_token: sealGraphToken(REFRESH),
    };
    const legacyRow = {
      connected_by: "u-legacy",
      user_email: "l@example.test",
      access_token: ACCESS,
      refresh_token: REFRESH,
    };
    const plan = planBackfill([sealedRow, legacyRow]);
    expect(plan.total).toBe(2);
    expect(plan.alreadySealed).toBe(1);
    expect(plan.unreadable).toEqual([]);
    expect(plan.updates).toHaveLength(1);
    const u = plan.updates[0];
    expect(u.connected_by).toBe("u-legacy");
    expect(u.prev_access_token).toBe(ACCESS);
    expect(u.prev_refresh_token).toBe(REFRESH);
    expect(isSealedToken(u.sealed_access_token)).toBe(true);
    expect(isSealedToken(u.sealed_refresh_token)).toBe(true);
    expect(openGraphToken(u.sealed_access_token)).toMatchObject({ value: ACCESS });
    expect(openGraphToken(u.sealed_refresh_token)).toMatchObject({ value: REFRESH });
  });

  it("keeps an already-sealed half as-is when only one half is legacy", () => {
    const sealedAccess = sealGraphToken(ACCESS);
    const plan = planBackfill([
      { connected_by: "u", user_email: "u@example.test", access_token: sealedAccess, refresh_token: REFRESH },
    ]);
    expect(plan.updates[0].sealed_access_token).toBe(sealedAccess);
    expect(isSealedToken(plan.updates[0].sealed_refresh_token)).toBe(true);
  });

  it("lists rows it cannot open as unreadable and never plans a write for them", () => {
    const sealed = sealGraphToken(ACCESS);
    useKey(KEY_B);
    const plan = planBackfill([
      { connected_by: "u-wrong-key", user_email: "w@example.test", access_token: sealed, refresh_token: REFRESH },
    ]);
    expect(plan.unreadable).toEqual(["u-wrong-key"]);
    expect(plan.updates).toEqual([]);
  });
});

describe("checkKey (refuses to seal under a key that is not the app's)", () => {
  it("accepts a key that opens every sealed sample", () => {
    const samples = [sealGraphToken(ACCESS), sealGraphToken(REFRESH), "legacy-plaintext"];
    expect(checkKey({ INSTINCT_SECRET_KEY: KEY_A } as unknown as NodeJS.ProcessEnv, samples)).toEqual({
      ok: true,
      verifiedAgainst: 2,
    });
  });

  it("refuses when no key is configured", () => {
    expect(checkKey(({} as unknown as NodeJS.ProcessEnv), [])).toEqual({ ok: false, reason: "no_key_configured" });
  });

  it("refuses a redacted key (vercel env pull)", () => {
    const env = { INSTINCT_JWT_SECRET: "[SENSITIVE] value redacted by vercel env pull" } as unknown as NodeJS.ProcessEnv;
    expect(checkKey(env, [])).toEqual({ ok: false, reason: "redacted_key" });
  });

  it("refuses when there is nothing sealed to prove the key against", () => {
    expect(checkKey({ INSTINCT_SECRET_KEY: KEY_A } as unknown as NodeJS.ProcessEnv, ["plain-only"])).toEqual({
      ok: false,
      reason: "no_sealed_sample",
    });
  });

  it("refuses a key that does not open the app's sealed values", () => {
    const sealedUnderA = sealGraphToken(ACCESS);
    useKey(KEY_B);
    expect(checkKey({ INSTINCT_SECRET_KEY: KEY_B } as unknown as NodeJS.ProcessEnv, [sealedUnderA])).toEqual({
      ok: false,
      reason: "key_mismatch",
    });
  });
});
