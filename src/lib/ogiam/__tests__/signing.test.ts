/**
 * Signer tests: config resolution (Key Vault vs local vs disabled), the stable
 * checkpoint payload, the local HMAC verify, and the Key Vault REST signer with
 * fetch mocked (token then sign, and graceful null on failure).
 */

import {
  getSigner,
  readKeyVaultConfig,
  checkpointPayload,
  verifyLocalHmac,
  verifyEs256,
  runSignerSelfTest,
  KeyVaultSigner,
} from "@/lib/ogiam/signing";
import { createHmac, generateKeyPairSync, sign as cryptoSign } from "crypto";

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

describe("readKeyVaultConfig", () => {
  it("returns config only when every field is present", () => {
    expect(readKeyVaultConfig({} as NodeJS.ProcessEnv)).toBeNull();
    const full = {
      OGIAM_KEYVAULT_URL: "https://v.vault.azure.net",
      OGIAM_KEYVAULT_KEY: "ogiam",
      AZURE_TENANT_ID: "t",
      AZURE_CLIENT_ID: "c",
      AZURE_CLIENT_SECRET: "s",
    } as unknown as NodeJS.ProcessEnv;
    expect(readKeyVaultConfig(full)).not.toBeNull();
    const partial = { ...full, AZURE_CLIENT_SECRET: "" } as NodeJS.ProcessEnv;
    expect(readKeyVaultConfig(partial)).toBeNull();
  });
});

describe("getSigner", () => {
  it("picks Key Vault when configured", () => {
    const s = getSigner({
      OGIAM_KEYVAULT_URL: "https://v.vault.azure.net",
      OGIAM_KEYVAULT_KEY: "ogiam",
      AZURE_TENANT_ID: "t",
      AZURE_CLIENT_ID: "c",
      AZURE_CLIENT_SECRET: "s",
    } as unknown as NodeJS.ProcessEnv);
    expect(s.isProduction).toBe(true);
    expect(s.algorithm).toBe("ES256");
  });

  it("falls back to local HMAC in non-production with a secret", () => {
    const s = getSigner({ OGIAM_SIGNING_SECRET: "shh", NODE_ENV: "test" } as unknown as NodeJS.ProcessEnv);
    expect(s.isProduction).toBe(false);
    expect(s.algorithm).toBe("HS256-local");
  });

  it("is disabled (null signer) with no config", () => {
    const s = getSigner({ NODE_ENV: "production" } as unknown as NodeJS.ProcessEnv);
    expect(s.algorithm).toBe("none");
  });

  it("never enables the local HMAC fallback in production", () => {
    const s = getSigner({ OGIAM_SIGNING_SECRET: "shh", NODE_ENV: "production" } as unknown as NodeJS.ProcessEnv);
    expect(s.algorithm).toBe("none");
  });
});

describe("checkpointPayload", () => {
  it("is stable for the same inputs", () => {
    expect(checkpointPayload("ws", 5, "abc")).toBe(checkpointPayload("ws", 5, "abc"));
    expect(checkpointPayload("ws", 5, "abc")).not.toBe(checkpointPayload("ws", 6, "abc"));
  });
});

describe("verifyLocalHmac", () => {
  it("accepts a valid signature and rejects a tampered one", () => {
    const payload = checkpointPayload("ws", 1, "head");
    const sig = createHmac("sha256", "secret").update(payload).digest("base64");
    expect(verifyLocalHmac(payload, sig, "secret")).toBe(true);
    expect(verifyLocalHmac(payload, sig, "wrong-secret")).toBe(false);
    expect(verifyLocalHmac("tampered", sig, "secret")).toBe(false);
  });
});

describe("verifyEs256 (independent ES256 verification)", () => {
  it("verifies a real P-256 signature (r||s) and rejects a tampered one", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const payload = checkpointPayload("ws", 9, "head-hash");
    // Sign as Key Vault does: ES256 over the payload, raw r||s.
    const sig = b64url(
      cryptoSign("sha256", Buffer.from(payload), { key: privateKey, dsaEncoding: "ieee-p1363" }),
    );
    const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
    expect(verifyEs256(payload, sig, { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y })).toBe(true);
    expect(verifyEs256("tampered", sig, { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y })).toBe(false);
  });
});

describe("runSignerSelfTest", () => {
  it("local signer signs and independently verifies the probe", async () => {
    const s = getSigner({ OGIAM_SIGNING_SECRET: "shh", NODE_ENV: "test" } as unknown as NodeJS.ProcessEnv);
    const r = await runSignerSelfTest(s, "nonce-1");
    expect(r.mode).toBe("local");
    expect(r.signed).toBe(true);
    expect(r.verified).toBe(true);
  });

  it("disabled signer reports not signed and no key id", async () => {
    const s = getSigner({ NODE_ENV: "production" } as unknown as NodeJS.ProcessEnv);
    const r = await runSignerSelfTest(s, "nonce-2");
    expect(r.mode).toBe("none");
    expect(r.signed).toBe(false);
    expect(r.verified).toBe(false);
    expect(r.keyId).toBe("");
  });
});

describe("KeyVaultSigner (fetch mocked)", () => {
  const cfg = {
    OGIAM_KEYVAULT_URL: "https://v.vault.azure.net",
    OGIAM_KEYVAULT_KEY: "ogiam",
    AZURE_TENANT_ID: "t",
    AZURE_CLIENT_ID: "c",
    AZURE_CLIENT_SECRET: "s",
  } as unknown as NodeJS.ProcessEnv;

  afterEach(() => {
    (global as unknown as { fetch?: unknown }).fetch = undefined;
  });

  it("acquires a token then calls the sign endpoint and returns the signature", async () => {
    const calls: string[] = [];
    (global as unknown as { fetch: jest.Mock }).fetch = jest.fn(async (url: string) => {
      calls.push(url);
      if (url.includes("login.microsoftonline.com")) {
        return { ok: true, json: async () => ({ access_token: "tok", expires_in: 3600 }) };
      }
      return { ok: true, json: async () => ({ kid: "kid-1", value: "SIGBASE64" }) };
    });
    const signer = new KeyVaultSigner(readKeyVaultConfig(cfg)!);
    const out = await signer.sign(checkpointPayload("ws", 1, "head"));
    expect(out.signature).toBe("SIGBASE64");
    expect(out.keyId).toBe("kid-1");
    expect(calls[0]).toContain("login.microsoftonline.com");
    expect(calls[1]).toContain("/keys/ogiam/sign");
  });

  it("returns a null signature (not a throw) when the vault call fails", async () => {
    (global as unknown as { fetch: jest.Mock }).fetch = jest.fn(async (url: string) => {
      if (url.includes("login.microsoftonline.com")) {
        return { ok: true, json: async () => ({ access_token: "tok", expires_in: 3600 }) };
      }
      return { ok: false, json: async () => ({}) };
    });
    const signer = new KeyVaultSigner(readKeyVaultConfig(cfg)!);
    const out = await signer.sign(checkpointPayload("ws", 1, "head"));
    expect(out.signature).toBeNull();
  });
});
