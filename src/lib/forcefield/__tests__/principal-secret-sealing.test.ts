/** @jest-environment node */
/**
 * Delegation issuer hs256 secrets are sealed at rest under the at-rest keyring
 * (registerDelegationIssuer), opened on read (getDelegationIssuer), re-sealed
 * in place when a row still holds the bare secret, and a tampered or wrong-key
 * value makes the issuer's delegations "claimed", never "verified". Drives the
 * real principal.ts against a mocked database so the SQL parameters can be
 * inspected.
 */
export {};

const mockQuery = jest.fn();
const mockSafeQuery = jest.fn();
const mockTrack = jest.fn();

jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: unknown[]) => mockTrack(...a) }));
jest.mock("@/lib/db", () => ({
  hasDatabase: () => true,
  query: (...a: unknown[]) => mockQuery(...a),
  safeQuery: (...a: unknown[]) => mockSafeQuery(...a),
}));

import { delegationSignature } from "@/lib/ogiam/delegate";
import { getDelegationIssuer, registerDelegationIssuer, verifyPresentedDelegation } from "@/lib/forcefield/principal";
import { isSealedToken, openStoredToken, sealStoredToken } from "@/lib/crypto/graph-token-storage";
import * as secretStorage from "@/lib/crypto/secret-storage";

const SECRET = "issuer-shared-secret-value";
const NOW = 1_700_000_000;
const SAVED = { ...process.env };

function row(secret: string | null) {
  return { id: "11111111-1111-4111-8111-111111111111", issuer: "acme", algorithm: "hs256", secret, public_key: null, allowed_scopes: [] };
}

function mint(secret: string): string {
  const json = JSON.stringify({ principal: "person:1", issuer: "acme", scopes: ["/catalog"], exp: NOW + 60, jti: "j1" });
  return `${Buffer.from(json, "utf8").toString("base64url")}.${NOW}.${delegationSignature(secret, json, NOW)}`;
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.restoreAllMocks();
  process.env.INSTINCT_SECRET_KEY = "f".repeat(64);
  secretStorage.__resetSecretKeyCacheForTests();
});

afterAll(() => {
  process.env = SAVED;
  secretStorage.__resetSecretKeyCacheForTests();
});

describe("registerDelegationIssuer stores the secret sealed", () => {
  it("never passes the secret to the database, and the sealed value round-trips", async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });
    await expect(registerDelegationIssuer({ workspaceId: "w1", issuer: "acme", secret: SECRET, createdBy: "u1" })).resolves.toEqual({ ok: true });
    const params = mockQuery.mock.calls[0][1] as unknown[];
    expect(params).not.toContain(SECRET);
    expect(JSON.stringify(params)).not.toContain(SECRET);
    expect(isSealedToken(params[3] as string)).toBe(true);
    expect(openStoredToken(params[3] as string)).toEqual({ ok: true, value: SECRET, format: "sealed" });
  });

  it("refuses (and writes nothing) when the secret cannot be sealed", async () => {
    jest.spyOn(secretStorage, "encryptSecret").mockImplementation((p: string) => `plain.${Buffer.from(p).toString("base64")}`);
    await expect(registerDelegationIssuer({ workspaceId: "w1", issuer: "acme", secret: SECRET, createdBy: "u1" })).resolves.toEqual({
      ok: false,
      reason: "secret_seal_failed",
    });
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockTrack).toHaveBeenCalledWith("forcefield.delegation_issuer_store_failed", "u1", "system", expect.objectContaining({ code: "seal_failed" }));
  });

  it("an es256 issuer has no secret to seal and stores NULL", async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });
    await expect(registerDelegationIssuer({ workspaceId: "w1", issuer: "asym", publicKey: { kty: "EC" } })).resolves.toEqual({ ok: true });
    expect((mockQuery.mock.calls[0][1] as unknown[])[3]).toBeNull();
  });
});

describe("getDelegationIssuer opens the stored secret", () => {
  it("opens a sealed secret without rewriting it, and a delegation signed with it verifies", async () => {
    mockSafeQuery.mockResolvedValue({ rows: [row(sealStoredToken(SECRET))] });
    const issuer = await getDelegationIssuer("w1", "acme");
    expect(issuer?.secret).toBe(SECRET);
    expect(mockQuery).not.toHaveBeenCalled();
    const v = await verifyPresentedDelegation(mint(SECRET), { resolveIssuer: async () => issuer, nowSeconds: NOW });
    expect(v.status).toBe("verified");
  });

  it("still reads a row holding the bare secret, then re-seals it in place once", async () => {
    mockSafeQuery.mockResolvedValue({ rows: [row(SECRET)] });
    mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });
    await expect(getDelegationIssuer("w1", "acme")).resolves.toMatchObject({ secret: SECRET });
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/UPDATE instinct_delegation_issuers SET secret = \$1/);
    expect(sql).toMatch(/workspace_id = \$3 AND secret = \$4/);
    expect(isSealedToken(params[0] as string)).toBe(true);
    expect(params.slice(2)).toEqual(["w1", SECRET]);
    expect(mockTrack).toHaveBeenCalledWith("security.delegation_secret_encrypted", "system", "system", { workspace_id: "w1", issuer: "acme", source: "lazy_read" });
  });

  it("a failed re-seal never fails the read", async () => {
    mockSafeQuery.mockResolvedValue({ rows: [row(SECRET)] });
    mockQuery.mockRejectedValue(new Error("connection terminated"));
    await expect(getDelegationIssuer("w1", "acme")).resolves.toMatchObject({ secret: SECRET });
  });

  it("a tampered or wrong-key secret is dropped: delegations read as claimed, and it is reported", async () => {
    const foreign = sealStoredToken(SECRET);
    process.env.INSTINCT_SECRET_KEY = "a".repeat(64);
    process.env.INSTINCT_JWT_SECRET = "a-different-jwt-secret-for-this-test-only";
    secretStorage.__resetSecretKeyCacheForTests();
    mockSafeQuery.mockResolvedValue({ rows: [row(foreign)] });
    const issuer = await getDelegationIssuer("w1", "acme");
    expect(issuer?.secret).toBeNull();
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockTrack).toHaveBeenCalledWith("security.delegation_secret_decrypt_failed", "system", "system", { workspace_id: "w1", issuer: "acme" });
    const v = await verifyPresentedDelegation(mint(SECRET), { resolveIssuer: async () => issuer, nowSeconds: NOW });
    expect(v.status).toBe("claimed");
    delete process.env.INSTINCT_JWT_SECRET;
  });

  it("an es256 issuer (no secret) loads unchanged", async () => {
    mockSafeQuery.mockResolvedValue({ rows: [{ ...row(null), algorithm: "es256", public_key: { kty: "EC" } }] });
    await expect(getDelegationIssuer("w1", "acme")).resolves.toMatchObject({ algorithm: "es256", secret: null, publicKey: { kty: "EC" } });
    expect(mockTrack).not.toHaveBeenCalled();
  });
});
