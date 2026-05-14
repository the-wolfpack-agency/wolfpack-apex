/**
 * secret-storage tests — AES-256-GCM encrypt/decrypt + tampering +
 * key-rotation + backwards-compat for pre-v1 plain rows.
 */

import {
  encryptSecret,
  decryptSecret,
  __resetSecretKeyCacheForTests,
} from "@/lib/crypto/secret-storage";

const ORIGINAL_SECRET = process.env.INSTINCT_SECRET_KEY;
const ORIGINAL_JWT = process.env.INSTINCT_JWT_SECRET;

beforeEach(() => {
  __resetSecretKeyCacheForTests();
  process.env.INSTINCT_JWT_SECRET = "test-jwt-secret-32-bytes-or-more";
});

afterAll(() => {
  if (ORIGINAL_SECRET === undefined) delete process.env.INSTINCT_SECRET_KEY;
  else process.env.INSTINCT_SECRET_KEY = ORIGINAL_SECRET;
  if (ORIGINAL_JWT === undefined) delete process.env.INSTINCT_JWT_SECRET;
  else process.env.INSTINCT_JWT_SECRET = ORIGINAL_JWT;
});

describe("encryptSecret / decryptSecret", () => {
  test("round-trips a plain ascii string", () => {
    const token = encryptSecret("Bearer abc123");
    expect(token).toMatch(/^v1\./);
    expect(decryptSecret(token)).toBe("Bearer abc123");
  });

  test("round-trips unicode + symbols + newlines", () => {
    const pt = "user@x.com\n— ✓ ★ Z";
    expect(decryptSecret(encryptSecret(pt))).toBe(pt);
  });

  test("each call produces a different ciphertext (random IV)", () => {
    const a = encryptSecret("same");
    const b = encryptSecret("same");
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe("same");
    expect(decryptSecret(b)).toBe("same");
  });

  test("decrypt returns null on tampered ciphertext", () => {
    const token = encryptSecret("Bearer secret");
    /* Flip a byte in the ciphertext segment. */
    const parts = token.split(".");
    const ct = Buffer.from(parts[3], "base64");
    ct[0] ^= 0xff;
    parts[3] = ct.toString("base64");
    const tampered = parts.join(".");
    expect(decryptSecret(tampered)).toBeNull();
  });

  test("decrypt returns null on wrong key", () => {
    process.env.INSTINCT_SECRET_KEY =
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    __resetSecretKeyCacheForTests();
    const token = encryptSecret("Bearer secret");

    process.env.INSTINCT_SECRET_KEY =
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    __resetSecretKeyCacheForTests();
    expect(decryptSecret(token)).toBeNull();
  });

  test("decrypt returns null on malformed token", () => {
    expect(decryptSecret("not-a-token")).toBe("not-a-token"); // pre-v1 passthrough
    expect(decryptSecret("v1.only-one-part")).toBeNull();
    expect(decryptSecret("v1...")).toBeNull();
    expect(decryptSecret("v1.notbase64!@#.x.y")).toBeNull();
    expect(decryptSecret("")).toBeNull();
  });

  test("backwards-compat: 'plain.' prefix decodes as utf-8 base64", () => {
    const pt = "legacy plaintext";
    const tok = "plain." + Buffer.from(pt, "utf8").toString("base64");
    expect(decryptSecret(tok)).toBe(pt);
  });

  test("backwards-compat: pre-v1 raw plaintext passes through verbatim", () => {
    expect(decryptSecret("legacy raw value")).toBe("legacy raw value");
  });

  test("uses INSTINCT_SECRET_KEY env when set (hex)", () => {
    process.env.INSTINCT_SECRET_KEY = "0".repeat(64);
    __resetSecretKeyCacheForTests();
    const token = encryptSecret("hello");
    expect(decryptSecret(token)).toBe("hello");
  });

  test("derives a key from INSTINCT_JWT_SECRET when SECRET_KEY is unset", () => {
    delete process.env.INSTINCT_SECRET_KEY;
    __resetSecretKeyCacheForTests();
    const token = encryptSecret("hello");
    expect(decryptSecret(token)).toBe("hello");
  });

  test("coerces non-string input to string before encrypting", () => {
    /* Helps when callers accidentally pass a number / null. */
    const token = encryptSecret(12345 as unknown as string);
    expect(decryptSecret(token)).toBe("12345");
  });
});
