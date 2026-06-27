/**
 * GitHub App JWT signing.
 *
 * Verifies signAppJwt produces a real RS256 JWT (header alg + verifiable
 * signature against the public key), backdates iat, caps exp under 10 minutes,
 * and that readAppConfigFromEnv recognises configured vs not-configured states
 * (including the literal-\n PEM normalisation Vercel introduces). NEVER hits
 * the network; the private key is generated in-process and never logged.
 */

import { generateKeyPairSync, createVerify } from "node:crypto";
import { signAppJwt, readAppConfigFromEnv } from "@/lib/github-app/jwt";

function b64urlToJson(seg: string): Record<string, unknown> {
  const b64 = seg.replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(Buffer.from(b64, "base64").toString("utf-8"));
}

describe("signAppJwt", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const config = { appId: "123456", privateKeyPem: privateKey };
  const FIXED = 1_700_000_000_000; // fixed ms clock

  it("produces a 3-part RS256 JWT with iss=appId", () => {
    const jwt = signAppJwt(config, { now: () => FIXED });
    const parts = jwt.split(".");
    expect(parts).toHaveLength(3);
    const header = b64urlToJson(parts[0]);
    const payload = b64urlToJson(parts[1]);
    expect(header.alg).toBe("RS256");
    expect(header.typ).toBe("JWT");
    expect(payload.iss).toBe("123456");
  });

  it("backdates iat by 30s and caps exp under GitHub's 10-minute ceiling", () => {
    const jwt = signAppJwt(config, { now: () => FIXED });
    const payload = b64urlToJson(jwt.split(".")[1]);
    const nowSec = Math.floor(FIXED / 1000);
    expect(payload.iat).toBe(nowSec - 30);
    expect(payload.exp).toBe(nowSec + 9 * 60);
    expect((payload.exp as number) - (payload.iat as number)).toBeLessThanOrEqual(600);
  });

  it("signature verifies against the public key (genuine RS256)", () => {
    const jwt = signAppJwt(config, { now: () => FIXED });
    const [h, p, sig] = jwt.split(".");
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${h}.${p}`);
    verifier.end();
    const ok = verifier.verify(
      publicKey,
      Buffer.from(sig.replace(/-/g, "+").replace(/_/g, "/"), "base64"),
    );
    expect(ok).toBe(true);
  });
});

describe("readAppConfigFromEnv", () => {
  const origId = process.env.GITHUB_APP_ID;
  const origKey = process.env.GITHUB_APP_PRIVATE_KEY;

  afterEach(() => {
    if (origId === undefined) delete process.env.GITHUB_APP_ID;
    else process.env.GITHUB_APP_ID = origId;
    if (origKey === undefined) delete process.env.GITHUB_APP_PRIVATE_KEY;
    else process.env.GITHUB_APP_PRIVATE_KEY = origKey;
  });

  it("returns null when the App id is missing", () => {
    delete process.env.GITHUB_APP_ID;
    process.env.GITHUB_APP_PRIVATE_KEY =
      "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----";
    expect(readAppConfigFromEnv()).toBeNull();
  });

  it("returns null when the private key is missing", () => {
    process.env.GITHUB_APP_ID = "123";
    delete process.env.GITHUB_APP_PRIVATE_KEY;
    expect(readAppConfigFromEnv()).toBeNull();
  });

  it("returns null when the key isn't a PEM", () => {
    process.env.GITHUB_APP_ID = "123";
    process.env.GITHUB_APP_PRIVATE_KEY = "not-a-pem";
    expect(readAppConfigFromEnv()).toBeNull();
  });

  it("normalises literal \\n newlines (Vercel single-line env)", () => {
    process.env.GITHUB_APP_ID = "123";
    process.env.GITHUB_APP_PRIVATE_KEY =
      "-----BEGIN PRIVATE KEY-----\\nMIIB\\n-----END PRIVATE KEY-----";
    const cfg = readAppConfigFromEnv();
    expect(cfg).not.toBeNull();
    expect(cfg!.privateKeyPem).toContain("\n");
    expect(cfg!.privateKeyPem).not.toContain("\\n");
    expect(cfg!.appId).toBe("123");
  });
});
