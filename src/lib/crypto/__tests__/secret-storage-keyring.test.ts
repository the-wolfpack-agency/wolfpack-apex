/**
 * secret-storage keyring: encrypt with the primary only; decrypt primary and
 * previous (legacy only without a primary, or for the rotation backfill); key ids in the token without breaking old v1 tokens;
 * once-per-process signals; no plaintext in errors or logs.
 */
import { execSync } from "node:child_process";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { join } from "node:path";

const trackEvent = jest.fn();
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: unknown[]) => trackEvent(...a) }));

import {
  encryptSecret,
  encryptSecretWithPrimary,
  decryptSecret,
  decryptSecretWithInfo,
  parseSecretKeyMaterial,
  secretKeyId,
  secretKeyringStatus,
  PrimaryKeyUnavailableError,
  __resetSecretKeyCacheForTests,
  setSecretKeySignalSink,
  allowLegacyKeyForBackfill,
  type SecretKeySignal,
} from "@/lib/crypto/secret-storage";
import { checkRotationKey, classifyValue } from "@/lib/crypto/secret-key-rotation";

const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);
const KEY_C_B64 = Buffer.alloc(32, 7).toString("base64");
const SECRET = "Bearer super-secret-value-123";

const SAVED = { ...process.env };
let signals: SecretKeySignal[] = [];

function setEnv(vars: Record<string, string | undefined>): void {
  for (const k of ["INSTINCT_SECRET_KEY", "INSTINCT_SECRET_KEY_PREVIOUS", "INSTINCT_JWT_SECRET", "VERCEL_ENV"]) delete process.env[k];
  for (const [k, v] of Object.entries(vars)) if (v !== undefined) process.env[k] = v;
  __resetSecretKeyCacheForTests();
}

/** A token exactly as the pre-keyring code wrote it (3 segments, no key id). */
function asRotation(fn: () => void): void {
  allowLegacyKeyForBackfill();
  try {
    fn();
  } finally {
    allowLegacyKeyForBackfill(false);
  }
}

function oldV1Token(plaintext: string, jwtSecret: string | undefined): string {
  const key = createHash("sha256").update("secret-storage:v1").update(":").update(jwtSecret ?? "instinct-dev-only").digest();
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  return `v1.${iv.toString("base64")}.${c.getAuthTag().toString("base64")}.${ct.toString("base64")}`;
}

beforeEach(() => {
  signals = [];
  trackEvent.mockClear();
  setSecretKeySignalSink((s) => signals.push(s));
  setEnv({});
});

afterAll(() => {
  process.env = SAVED;
  setSecretKeySignalSink(null);
  __resetSecretKeyCacheForTests();
});

describe("encrypt", () => {
  test("uses the primary key and stamps its key id", () => {
    setEnv({ INSTINCT_SECRET_KEY: KEY_A });
    const kid = secretKeyId(Buffer.from(KEY_A, "hex"));
    const tok = encryptSecret(SECRET);
    expect(tok.startsWith(`v1.${kid}.`)).toBe(true);
    expect(tok.split(".")).toHaveLength(5);
    const r = decryptSecretWithInfo(tok);
    expect(r).toEqual({ ok: true, value: SECRET, format: "v1", keyClass: "primary", kid });
  });

  test("never encrypts with a previous key", () => {
    setEnv({ INSTINCT_SECRET_KEY: KEY_A, INSTINCT_SECRET_KEY_PREVIOUS: KEY_B });
    const r = decryptSecretWithInfo(encryptSecret(SECRET));
    expect(r.ok && r.format === "v1" && r.keyClass).toBe("primary");
  });

  test("without a primary, keeps the original format and key (nothing breaks pre-env)", () => {
    setEnv({ INSTINCT_JWT_SECRET: "jwt-secret-at-least-32-characters-long" });
    const tok = encryptSecret(SECRET);
    expect(tok.split(".")).toHaveLength(4);
    const r = decryptSecretWithInfo(tok);
    expect(r.ok && r.format === "v1" && r.keyClass).toBe("legacy");
  });

  test("an invalid primary is treated as absent, as before", () => {
    setEnv({ INSTINCT_SECRET_KEY: "not-a-valid-key-but-longer-than-32-chars!!" });
    expect(secretKeyringStatus().primaryProblem).toBe("invalid");
    expect(encryptSecret(SECRET).split(".")).toHaveLength(4);
  });

  test("encryptSecretWithPrimary throws without a primary, and the error carries no value", () => {
    setEnv({});
    let caught: unknown;
    try {
      encryptSecretWithPrimary(SECRET);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(PrimaryKeyUnavailableError);
    expect(String((caught as Error).message)).not.toContain(SECRET);
  });
});

describe("decrypt", () => {
  test("primary and previous open; legacy does not once a primary is set", () => {
    setEnv({ INSTINCT_SECRET_KEY: KEY_B });
    const underB = encryptSecret("from-b");
    setEnv({ INSTINCT_SECRET_KEY: KEY_A, INSTINCT_SECRET_KEY_PREVIOUS: `${KEY_C_B64}, ${KEY_B}` });
    const underA = encryptSecret("from-a");
    const legacy = oldV1Token("from-legacy", undefined);

    expect(decryptSecretWithInfo(underA)).toMatchObject({ ok: true, value: "from-a", keyClass: "primary" });
    expect(decryptSecretWithInfo(underB)).toMatchObject({ ok: true, value: "from-b", keyClass: "previous" });
    expect(decryptSecretWithInfo(legacy)).toEqual({ ok: false });
    expect(classifyValue(legacy)).toBe("unreadable");
    expect(secretKeyringStatus().previousKids).toHaveLength(2);
  });

  test("old v1 tokens open without a primary; with one, only for the rotation backfill", () => {
    const jwt = "jwt-secret-at-least-32-characters-long";
    setEnv({ INSTINCT_JWT_SECRET: jwt });
    expect(decryptSecret(oldV1Token(SECRET, jwt))).toBe(SECRET);
    setEnv({ INSTINCT_SECRET_KEY: KEY_A, INSTINCT_JWT_SECRET: jwt });
    expect(decryptSecret(oldV1Token(SECRET, jwt))).toBeNull();
    asRotation(() => {
      expect(decryptSecretWithInfo(oldV1Token(SECRET, jwt))).toMatchObject({ ok: true, value: SECRET, keyClass: "legacy" });
      setEnv({ INSTINCT_SECRET_KEY: KEY_A });
      expect(decryptSecret(oldV1Token(SECRET, undefined))).toBe(SECRET);
    });
  });

  test("only the operator backfill scripts turn the legacy key back on", () => {
    const callers = execSync("git grep -l allowLegacyKeyForBackfill -- src scripts", { cwd: join(__dirname, "../../../.."), encoding: "utf8" })
      .split("\n")
      .filter(Boolean)
      .filter((f) => !f.includes("__tests__/"));
    expect(callers.sort()).toEqual([
      "scripts/encrypt-graph-tokens.ts",
      "scripts/rotate-secret-key.ts",
      "scripts/seal-at-rest-secrets.ts",
      "src/lib/crypto/secret-storage.ts",
    ]);
  });

  test("a value from a key that is no longer in the ring reads as unavailable", () => {
    setEnv({ INSTINCT_SECRET_KEY: KEY_B });
    const tok = encryptSecret(SECRET);
    setEnv({ INSTINCT_SECRET_KEY: KEY_A });
    expect(decryptSecret(tok)).toBeNull();
    expect(classifyValue(tok)).toBe("unreadable");
  });

  test("tampered ciphertext, tag or key id read as unavailable", () => {
    setEnv({ INSTINCT_SECRET_KEY: KEY_A });
    const tok = encryptSecret(SECRET);
    const parts = tok.split(".");
    const ct = Buffer.from(parts[4], "base64");
    ct[0] ^= 0xff;
    expect(decryptSecret([...parts.slice(0, 4), ct.toString("base64")].join("."))).toBeNull();
    const tag = Buffer.from(parts[3], "base64");
    tag[0] ^= 0x01;
    expect(decryptSecret([parts[0], parts[1], parts[2], tag.toString("base64"), parts[4]].join("."))).toBeNull();
    expect(decryptSecret([parts[0], "kzzzz", ...parts.slice(2)].join("."))).toBeNull();
    /* A well-formed but wrong key id still opens: the id is a hint, GCM is the check. */
    expect(decryptSecret([parts[0], "k0000000000000000", ...parts.slice(2)].join("."))).toBe(SECRET);
  });

  test("plain. envelope and raw plaintext keep their old behavior", () => {
    setEnv({ INSTINCT_SECRET_KEY: KEY_A });
    expect(decryptSecretWithInfo("plain." + Buffer.from("x").toString("base64"))).toEqual({ ok: true, value: "x", format: "plain_envelope" });
    expect(decryptSecretWithInfo("raw-value")).toEqual({ ok: true, value: "raw-value", format: "raw_plaintext" });
    expect(decryptSecret("")).toBeNull();
    expect(decryptSecret("v1.a.b")).toBeNull();
  });
});

describe("signals", () => {
  test("legacy decrypt (rotation only) is signalled once per process, not per call", () => {
    setEnv({ INSTINCT_SECRET_KEY: KEY_A });
    const legacy = oldV1Token(SECRET, undefined);
    asRotation(() => {
      for (let i = 0; i < 5; i++) expect(decryptSecret(legacy)).toBe(SECRET);
    });
    const old = signals.filter((s) => s.event === "security.secret_old_key_decrypt");
    expect(old).toHaveLength(1);
    expect(old[0].metadata).toMatchObject({ key_class: "legacy", primary_kid: secretKeyId(Buffer.from(KEY_A, "hex")) });
  });

  test("previous-key decrypt is signalled separately, also once", () => {
    setEnv({ INSTINCT_SECRET_KEY: KEY_B });
    const underB = encryptSecret(SECRET);
    setEnv({ INSTINCT_SECRET_KEY: KEY_A, INSTINCT_SECRET_KEY_PREVIOUS: KEY_B });
    decryptSecret(underB);
    decryptSecret(underB);
    asRotation(() => decryptSecret(oldV1Token(SECRET, undefined)));
    const old = signals.filter((s) => s.event === "security.secret_old_key_decrypt").map((s) => s.metadata.key_class);
    expect(old).toEqual(["previous", "legacy"]);
  });

  test("primary decrypts emit no old-key signal; primary_active fires once", () => {
    setEnv({ INSTINCT_SECRET_KEY: KEY_A });
    decryptSecret(encryptSecret(SECRET));
    decryptSecret(encryptSecret(SECRET));
    expect(signals.map((s) => s.event)).toEqual(["security.secret_key_primary_active"]);
  });

  test("production without a primary: loud degraded signal once, behavior unchanged", () => {
    const err = jest.spyOn(console, "error").mockImplementation(() => {});
    setEnv({ VERCEL_ENV: "production" });
    const tok = encryptSecret(SECRET);
    encryptSecret(SECRET);
    expect(decryptSecret(tok)).toBe(SECRET);
    const degraded = signals.filter((s) => s.event === "security.secret_key_degraded");
    expect(degraded).toHaveLength(1);
    expect(degraded[0].metadata.reason).toBe("primary_unset");
    expect(err).toHaveBeenCalledTimes(1);
    /* No old-key signal in legacy-only mode: that is the degraded state. */
    expect(signals.some((s) => s.event === "security.secret_old_key_decrypt")).toBe(false);
    err.mockRestore();
  });

  test("non-production without a primary stays quiet", () => {
    setEnv({});
    encryptSecret(SECRET);
    expect(signals).toHaveLength(0);
  });

  test("the default sink sends to analytics outside jest and never throws", () => {
    setSecretKeySignalSink(null);
    const env = process.env as Record<string, string | undefined>;
    const prevNodeEnv = env.NODE_ENV;
    env.NODE_ENV = "development";
    try {
      setEnv({ INSTINCT_SECRET_KEY: KEY_A });
      asRotation(() => decryptSecret(oldV1Token(SECRET, undefined)));
      const names = trackEvent.mock.calls.map((c) => c[0]);
      expect(names).toEqual(["security.secret_key_primary_active", "security.secret_old_key_decrypt"]);
      trackEvent.mockImplementationOnce(() => {
        throw new Error("db down");
      });
      setEnv({ INSTINCT_SECRET_KEY: KEY_B });
      expect(decryptSecret(encryptSecret(SECRET))).toBe(SECRET);
    } finally {
      env.NODE_ENV = prevNodeEnv;
    }
  });

  test("no signal, log or error carries plaintext, ciphertext or key material", () => {
    const logs: string[] = [];
    const spies = (["log", "warn", "error", "info"] as const).map((m) =>
      jest.spyOn(console, m).mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(" "))),
    );
    setEnv({ INSTINCT_SECRET_KEY: KEY_A, VERCEL_ENV: "production" });
    const tok = encryptSecret(SECRET);
    decryptSecret(oldV1Token(SECRET, undefined));
    decryptSecret(tok.slice(0, -4) + "AAAA");
    setEnv({ VERCEL_ENV: "production" });
    encryptSecret(SECRET);
    spies.forEach((s) => s.mockRestore());
    const blob = JSON.stringify(signals) + logs.join("\n");
    expect(blob).not.toContain(SECRET);
    expect(blob).not.toContain(KEY_A);
    expect(blob).not.toContain(tok.split(".")[4]);
  });
});

describe("key material parsing and the rotation key check", () => {
  test("hex and base64 accepted; short, malformed and placeholders refused", () => {
    expect(parseSecretKeyMaterial(KEY_A)?.length).toBe(32);
    expect(parseSecretKeyMaterial(KEY_C_B64)?.length).toBe(32);
    expect(parseSecretKeyMaterial("abc")).toBeNull();
    expect(parseSecretKeyMaterial("[SENSITIVE]".padEnd(44, "A"))).toBeNull();
    expect(parseSecretKeyMaterial(undefined)).toBeNull();
  });

  test("checkRotationKey", () => {
    expect(checkRotationKey({} as NodeJS.ProcessEnv)).toEqual({ ok: false, reason: "no_primary_key" });
    expect(checkRotationKey({ INSTINCT_SECRET_KEY: "[SENSITIVE]" } as unknown as NodeJS.ProcessEnv)).toEqual({ ok: false, reason: "redacted_placeholder" });
    expect(checkRotationKey({ INSTINCT_SECRET_KEY: "REDACTED_VALUE_FROM_VERCEL_ENV_PULL_XXXXX" } as unknown as NodeJS.ProcessEnv)).toEqual({ ok: false, reason: "redacted_placeholder" });
    expect(checkRotationKey({ INSTINCT_SECRET_KEY: "too-short" } as unknown as NodeJS.ProcessEnv)).toEqual({ ok: false, reason: "invalid_primary_key" });
    expect(checkRotationKey({ INSTINCT_SECRET_KEY: KEY_A } as unknown as NodeJS.ProcessEnv)).toEqual({ ok: true, primaryKid: secretKeyId(Buffer.from(KEY_A, "hex")) });
  });

  test("key id is stable, non-reversible-looking, and distinct per key", () => {
    const a = secretKeyId(Buffer.from(KEY_A, "hex"));
    expect(a).toMatch(/^k[0-9a-f]{16}$/);
    expect(a).toBe(secretKeyId(Buffer.from(KEY_A, "hex")));
    expect(a).not.toBe(secretKeyId(Buffer.from(KEY_B, "hex")));
    expect(KEY_A).not.toContain(a.slice(1));
  });
});
