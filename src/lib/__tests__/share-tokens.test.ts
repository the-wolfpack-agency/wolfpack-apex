/**
 * share-tokens.ts — sign/verify + DB orchestration tests.
 *
 * Mocks @/lib/db so no real Postgres is touched. Exercises:
 *   - sign → verify round-trip (happy path)
 *   - tampered payload rejected
 *   - tampered signature rejected
 *   - truncated token rejected
 *   - malformed base64 rejected
 *   - expired token rejected
 *   - wrong-secret rejected
 *   - issueShareToken writes the expected row + returns metadata
 *   - issueShareToken clamps TTL at the 90-day max
 *   - issueShareToken rejects zero / negative TTL at the route (unit
 *     test covered in share-route.test.ts — here we assert clamp)
 *   - revokeShareToken fires the expected UPDATE
 *   - touchShareTokenAccess bumps counter
 *   - loadActiveTokenRow returns null for revoked rows
 *   - loadActiveTokenRow returns null for expired rows
 *   - listShareTokensForSite orders by created_at desc
 */

const safeQueryMock = jest.fn();
jest.mock("@/lib/db", () => ({
  safeQuery: (...args: unknown[]) => safeQueryMock(...args),
}));

import {
  signShareToken,
  verifyShareToken,
  issueShareToken,
  revokeShareToken,
  touchShareTokenAccess,
  loadActiveTokenRow,
  listShareTokensForSite,
  getShareSecret,
  type ShareTokenClaims,
} from "@/lib/share-tokens";

const TEST_SECRET = "share-test-secret-never-use-in-production";

beforeEach(() => {
  jest.clearAllMocks();
  (process.env as Record<string, string>).NODE_ENV = "test";
});

describe("signShareToken + verifyShareToken", () => {
  const claims: ShareTokenClaims = {
    siteId: "site_abc",
    nonce: "nonce-1",
    exp: Math.floor(Date.now() / 1000) + 60,
  };

  it("round-trips a valid claims object", () => {
    const token = signShareToken(claims, TEST_SECRET);
    const result = verifyShareToken(token, TEST_SECRET);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.claims).toEqual(claims);
    }
  });

  it("rejects a tampered payload", () => {
    const token = signShareToken(claims, TEST_SECRET);
    const [payloadB64, sigB64] = token.split(".");
    // Flip one character in the payload but keep the old sig.
    const tampered =
      payloadB64.slice(0, -2) +
      (payloadB64.slice(-2, -1) === "A" ? "B" : "A") +
      payloadB64.slice(-1) +
      "." +
      sigB64;
    const result = verifyShareToken(tampered, TEST_SECRET);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(["bad_signature", "malformed"]).toContain(result.reason);
  });

  it("rejects a tampered signature", () => {
    const token = signShareToken(claims, TEST_SECRET);
    const parts = token.split(".");
    const badSig = parts[1].replace(/.$/, (ch) => (ch === "A" ? "B" : "A"));
    const result = verifyShareToken(parts[0] + "." + badSig, TEST_SECRET);
    expect(result.ok).toBe(false);
  });

  it("rejects a malformed token (no dot)", () => {
    const result = verifyShareToken("not-a-valid-token", TEST_SECRET);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("malformed");
  });

  it("rejects an empty string", () => {
    const result = verifyShareToken("", TEST_SECRET);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("malformed");
  });

  it("rejects a token signed with the wrong secret", () => {
    const token = signShareToken(claims, "other-secret");
    const result = verifyShareToken(token, TEST_SECRET);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("bad_signature");
  });

  it("rejects an expired token", () => {
    const expired: ShareTokenClaims = {
      siteId: "site_abc",
      nonce: "nonce-exp",
      exp: Math.floor(Date.now() / 1000) - 1,
    };
    const token = signShareToken(expired, TEST_SECRET);
    const result = verifyShareToken(token, TEST_SECRET);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("expired");
  });

  it("rejects malformed JSON in payload", () => {
    // Handcraft a valid-HMAC envelope around non-JSON payload
    const payload = Buffer.from("not json", "utf-8").toString("base64")
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const { createHmac } = jest.requireActual("node:crypto") as typeof import("node:crypto");
    const sig = createHmac("sha256", TEST_SECRET).update(payload).digest("base64")
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const result = verifyShareToken(`${payload}.${sig}`, TEST_SECRET);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("malformed");
  });
});

describe("issueShareToken", () => {
  it("inserts a share-token row + returns a signed blob + metadata", async () => {
    safeQueryMock.mockResolvedValueOnce({
      rows: [{ id: "row-uuid-1" }],
      fromCache: false,
    });
    const issued = await issueShareToken({
      siteId: "site_1",
      createdBy: "user-xyz",
      ttlSeconds: 3600,
      secret: TEST_SECRET,
    });
    expect(issued.tokenRowId).toBe("row-uuid-1");
    expect(issued.token).toMatch(/^[-_A-Za-z0-9]+\.[-_A-Za-z0-9]+$/);
    expect(issued.expiresAt.getTime()).toBeGreaterThan(Date.now());
    const verified = verifyShareToken(issued.token, TEST_SECRET);
    expect(verified.ok).toBe(true);
    if (verified.ok) expect(verified.claims.siteId).toBe("site_1");

    expect(safeQueryMock).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO apex_share_tokens"),
      expect.arrayContaining(["site_1", issued.nonce, "user-xyz"]),
    );
  });

  it("clamps TTL at the 90-day ceiling", async () => {
    safeQueryMock.mockResolvedValueOnce({ rows: [{ id: "row-2" }], fromCache: false });
    const issued = await issueShareToken({
      siteId: "site_2",
      ttlSeconds: 10_000_000, // ~115 days
      secret: TEST_SECRET,
    });
    const ninetyDaysSec = 90 * 24 * 60 * 60;
    const deltaSec = Math.round((issued.expiresAt.getTime() - Date.now()) / 1000);
    // Should be approximately 90 days, not 115.
    expect(deltaSec).toBeLessThanOrEqual(ninetyDaysSec + 5);
    expect(deltaSec).toBeGreaterThanOrEqual(ninetyDaysSec - 5);
  });

  it("synthesises a row id when the DB is in shadow mode", async () => {
    safeQueryMock.mockResolvedValueOnce({ rows: [], fromCache: true });
    const issued = await issueShareToken({
      siteId: "site_3",
      ttlSeconds: 60,
      secret: TEST_SECRET,
    });
    expect(issued.tokenRowId).toMatch(/^share_shadow_/);
  });
});

describe("revokeShareToken", () => {
  it("runs the UPDATE with the row id + idempotent NULL guard", async () => {
    safeQueryMock.mockResolvedValueOnce({ rows: [], fromCache: false });
    await revokeShareToken("row-9");
    expect(safeQueryMock).toHaveBeenCalledWith(
      expect.stringMatching(/UPDATE apex_share_tokens[\s\S]*revoked_at = NOW\(\)[\s\S]*revoked_at IS NULL/),
      ["row-9"],
    );
  });
});

describe("touchShareTokenAccess", () => {
  it("bumps last_accessed_at + access_count", async () => {
    safeQueryMock.mockResolvedValueOnce({ rows: [], fromCache: false });
    await touchShareTokenAccess("row-10");
    expect(safeQueryMock).toHaveBeenCalledWith(
      expect.stringMatching(/last_accessed_at = NOW\(\)[\s\S]*access_count = access_count \+ 1/),
      ["row-10"],
    );
  });
});

describe("loadActiveTokenRow", () => {
  const baseRow = {
    id: "r1",
    site_id: "site_1",
    nonce: "n1",
    created_by: null,
    created_at: "2026-01-01T00:00:00Z",
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
    revoked_at: null,
    last_accessed_at: null,
    access_count: 0,
  };

  it("returns the row for a live non-revoked nonce", async () => {
    safeQueryMock.mockResolvedValueOnce({ rows: [baseRow], fromCache: false });
    const row = await loadActiveTokenRow("n1");
    expect(row).not.toBeNull();
    expect(row?.id).toBe("r1");
  });

  it("returns null for a revoked nonce", async () => {
    safeQueryMock.mockResolvedValueOnce({
      rows: [{ ...baseRow, revoked_at: "2026-04-18T00:00:00Z" }],
      fromCache: false,
    });
    const row = await loadActiveTokenRow("n1");
    expect(row).toBeNull();
  });

  it("returns null for an expired nonce", async () => {
    safeQueryMock.mockResolvedValueOnce({
      rows: [{ ...baseRow, expires_at: new Date(Date.now() - 1000).toISOString() }],
      fromCache: false,
    });
    const row = await loadActiveTokenRow("n1");
    expect(row).toBeNull();
  });

  it("returns null for an unknown nonce", async () => {
    safeQueryMock.mockResolvedValueOnce({ rows: [], fromCache: false });
    const row = await loadActiveTokenRow("unknown-nonce");
    expect(row).toBeNull();
  });
});

describe("listShareTokensForSite", () => {
  it("queries by site_id with ORDER BY created_at DESC", async () => {
    safeQueryMock.mockResolvedValueOnce({ rows: [], fromCache: false });
    await listShareTokensForSite("site_q");
    const sqlCalled = String(safeQueryMock.mock.calls[0][0]);
    expect(sqlCalled).toMatch(/FROM apex_share_tokens/);
    expect(sqlCalled).toMatch(/WHERE site_id = \$1/);
    expect(sqlCalled).toMatch(/ORDER BY created_at DESC/);
  });
});

describe("getShareSecret", () => {
  afterEach(() => {
    delete process.env.INSTINCT_SHARE_SECRET;
    (process.env as Record<string, string>).NODE_ENV = "test";
  });

  it("returns the env value when set", () => {
    process.env.INSTINCT_SHARE_SECRET = "live-secret-from-env";
    expect(getShareSecret()).toBe("live-secret-from-env");
  });

  it("falls back to a deterministic test secret in test env", () => {
    (process.env as Record<string, string>).NODE_ENV = "test";
    expect(getShareSecret()).toBe(TEST_SECRET);
  });
});
