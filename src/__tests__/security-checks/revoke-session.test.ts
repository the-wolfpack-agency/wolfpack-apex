/**
 * security:revoke-session: argument parsing, the dry-run default, and the SQL
 * that actually ends a family (the real revokeFamilyTokens over a mocked query).
 */
jest.mock("@/lib/db", () => ({ query: jest.fn() }));
jest.mock("@/lib/analytics", () => ({ trackEvent: jest.fn(), trackEventAwait: jest.fn() }));

import { query } from "@/lib/db";
import { revokeFamilyTokens } from "@/lib/crypto/refresh-tokens";
import {
  FAMILY_ROWS_SQL,
  TOKEN_FAMILY_SQL,
  UNREVOKED_COUNT_SQL,
  USER_FAMILIES_SQL,
  applyRevocation,
  countUnrevoked,
  extractTokenId,
  parseRevokeArgs,
  planRevocation,
  renderPlan,
  type QueryFn,
} from "../../../scripts/security/lib/revoke-session";

const TOKEN = "0b5f2c1e-9a4d-4f7e-8c3b-1d2e3f4a5b6c";
const FAMILY = "11111111-2222-4333-8444-555555555555";
const NOW = new Date("2026-10-24T12:00:00Z");

function fakeDb(): jest.Mock {
  return jest.fn(async (text: string) => {
    if (text === TOKEN_FAMILY_SQL) return { rows: [{ family_id: FAMILY, user_id: "u-cto" }] };
    if (text === USER_FAMILIES_SQL) return { rows: [{ family_id: FAMILY, user_id: "u-cto" }] };
    if (text === FAMILY_ROWS_SQL) {
      return {
        rows: [
          { issued_at: new Date("2026-10-20T10:00:00Z"), expires_at: new Date("2026-10-27T10:00:00Z"), used_at: new Date("2026-10-20T10:15:00Z"), revoked_at: null },
          { issued_at: new Date("2026-10-20T10:15:00Z"), expires_at: new Date("2026-10-27T10:15:00Z"), used_at: null, revoked_at: null },
        ],
      };
    }
    if (text === UNREVOKED_COUNT_SQL) return { rows: [{ n: 0 }] };
    throw new Error(`unexpected SQL: ${text}`);
  });
}

describe("parseRevokeArgs", () => {
  it("defaults to a dry run", () => {
    expect(parseRevokeArgs(["--token-file", "/tmp/t"])).toEqual({ tokenFile: "/tmp/t", userId: null, apply: false, reason: "leaked session" });
    expect(parseRevokeArgs(["--user-id", "u1", "--dry-run"])).toMatchObject({ userId: "u1", apply: false });
  });

  it("writes only with --apply", () => {
    expect(parseRevokeArgs(["--user-id", "u1", "--apply", "--reason", "trace leak"])).toMatchObject({ apply: true, reason: "trace leak" });
  });

  it("refuses ambiguous or missing input, and a token on the command line", () => {
    expect(parseRevokeArgs([])).toHaveProperty("error");
    expect(parseRevokeArgs(["--token-file", "a", "--user-id", "b"])).toHaveProperty("error");
    expect(parseRevokeArgs(["--token-file"])).toHaveProperty("error");
    expect(parseRevokeArgs(["--user-id", "u", "--apply", "--dry-run"])).toHaveProperty("error");
    const r = parseRevokeArgs(["--token", TOKEN]);
    expect("error" in r && r.error).toMatch(/--token-file/);
    expect("error" in r && r.error).not.toContain(TOKEN);
  });
});

describe("extractTokenId", () => {
  it("reads a bare value, a cookie line and a storage-state JSON", () => {
    expect(extractTokenId(`${TOKEN}\n`)).toBe(TOKEN);
    expect(extractTokenId(`Cookie: a=b; instinct_refresh_token=${TOKEN}; instinct_access_token=x`)).toBe(TOKEN);
    expect(extractTokenId(JSON.stringify({ cookies: [{ name: "instinct_refresh_token", value: TOKEN, domain: "x" }] }))).toBe(TOKEN);
  });

  it("returns null for anything else", () => {
    expect(extractTokenId("")).toBeNull();
    expect(extractTokenId("not-a-token")).toBeNull();
    expect(extractTokenId("instinct_access_token=eyJabc")).toBeNull();
  });
});

describe("planRevocation", () => {
  it("looks the family up by token id and reports row states without the token", async () => {
    const q = fakeDb();
    const r = await planRevocation(q as unknown as QueryFn, { tokenId: TOKEN }, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(q.mock.calls[0]).toEqual([TOKEN_FAMILY_SQL, [TOKEN]]);
    expect(q.mock.calls[1]).toEqual([FAMILY_ROWS_SQL, [FAMILY]]);
    expect(r.plans[0]).toMatchObject({ familyId: FAMILY, userId: "u-cto", unrevoked: 2, live: 1 });
    const out = renderPlan(r.plans, false);
    expect(out).toMatch(/^DRY RUN/);
    expect(out).toContain("used (rotated)");
    expect(out).toContain("LIVE");
    expect(out).toContain("expires 2026-10-27T10:15:00.000Z");
    expect(out).not.toContain(TOKEN);
  });

  it("finds every live family for a user", async () => {
    const q = fakeDb();
    const r = await planRevocation(q as unknown as QueryFn, { userId: "u-cto" }, NOW);
    expect(q.mock.calls[0]).toEqual([USER_FAMILIES_SQL, ["u-cto"]]);
    expect(USER_FAMILIES_SQL).toMatch(/revoked_at IS NULL AND expires_at > now\(\)/);
    expect(r.ok && r.plans.length).toBe(1);
  });

  it("refuses when the token is not in this database", async () => {
    const q = jest.fn(async () => ({ rows: [] }));
    const r = await planRevocation(q as unknown as QueryFn, { tokenId: TOKEN }, NOW);
    expect(r).toEqual({ ok: false, message: expect.stringMatching(/DATABASE_URL/) });
  });

  it("says when there is nothing to revoke", () => {
    expect(renderPlan([], false)).toContain("Nothing to revoke");
  });
});

describe("applyRevocation", () => {
  beforeEach(() => (query as jest.Mock).mockReset().mockResolvedValue({ rows: [], rowCount: 2 }));

  it("runs the family UPDATE through the real revokeFamilyTokens, then analytics and audit", async () => {
    const plan = await planRevocation(fakeDb() as unknown as QueryFn, { tokenId: TOKEN }, NOW);
    if (!plan.ok) throw new Error("plan failed");
    const track = jest.fn(async () => undefined);
    const audit = jest.fn(async () => ({}));
    const done = await applyRevocation({ revokeFamily: revokeFamilyTokens, track, audit, actor: "operator:test" }, plan.plans, "token", "trace leak");

    expect(done).toEqual([{ familyId: FAMILY, rowsRevoked: 2 }]);
    const [sql, params] = (query as jest.Mock).mock.calls[0];
    expect(sql.replace(/\s+/g, " ").trim()).toBe("UPDATE instinct_refresh_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL");
    expect(params).toEqual([FAMILY]);
    expect(track).toHaveBeenCalledWith("security.session_family_revoked", "operator:test", "operator", expect.objectContaining({ family_id: FAMILY, rows_revoked: 2, mode: "token" }));
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "auth.session_family.revoked", resourceType: "auth_session", resourceId: FAMILY }));
    expect(JSON.stringify([track.mock.calls, audit.mock.calls])).not.toContain(TOKEN);
  });

  it("skips a family that is already fully revoked", async () => {
    const revokeFamily = jest.fn(async () => undefined);
    const done = await applyRevocation(
      { revokeFamily, track: jest.fn(async () => undefined), audit: jest.fn(async () => ({})), actor: "a" },
      [{ familyId: FAMILY, userId: "u", rows: [], unrevoked: 0, live: 0 }],
      "user",
      "r",
    );
    expect(done).toEqual([]);
    expect(revokeFamily).not.toHaveBeenCalled();
  });

  it("verifies by counting rows left unrevoked", async () => {
    const q = fakeDb();
    expect(await countUnrevoked(q as unknown as QueryFn, [FAMILY])).toBe(0);
    expect(q).toHaveBeenCalledWith(UNREVOKED_COUNT_SQL, [FAMILY]);
  });
});
