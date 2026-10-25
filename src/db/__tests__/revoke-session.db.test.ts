/** @jest-environment node
 *
 * Real-Postgres test of security:revoke-session (scripts/security/lib/revoke-session.ts)
 * against migration 017: the plan reads the right family, the family UPDATE ends
 * every unrevoked row and leaves other families alone, a second run changes
 * nothing, and the verification count reads zero. Skipped unless
 * TEST_DATABASE_URL is set (npm run test:db provides a throwaway container).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { requireLocalTestDatabase } from "./db-test-safety";
import { countUnrevoked, planRevocation, type QueryFn } from "../../../scripts/security/lib/revoke-session";

const URL = process.env.TEST_DATABASE_URL;
const describeIfDb = URL ? describe : describe.skip;
const MIGRATION = join(__dirname, "..", "migrations", "017_refresh_tokens.sql");

// Verbatim from revokeFamilyTokens in src/lib/crypto/refresh-tokens.ts.
const REVOKE_FAMILY = `UPDATE instinct_refresh_tokens
     SET revoked_at = now()
     WHERE family_id = $1 AND revoked_at IS NULL`;

const LEAKED = "0b5f2c1e-9a4d-4f7e-8c3b-1d2e3f4a5b6c";
const ROTATED = "0b5f2c1e-9a4d-4f7e-8c3b-1d2e3f4a5b6d";
const OTHER = "0b5f2c1e-9a4d-4f7e-8c3b-1d2e3f4a5b6e";
const FAM = "11111111-2222-4333-8444-555555555555";
const FAM_OTHER = "11111111-2222-4333-8444-666666666666";

describeIfDb("revoke-session against instinct_refresh_tokens (real Postgres, migration 017)", () => {
  let db: Client;
  let q: QueryFn;
  beforeAll(async () => {
    db = new Client({ connectionString: requireLocalTestDatabase(URL) });
    await db.connect();
    await db.query(readFileSync(MIGRATION, "utf8"));
    q = (text, params) => db.query(text, params as unknown[]);
  });
  afterAll(async () => {
    await db?.end();
  });
  beforeEach(async () => {
    await db.query("DELETE FROM instinct_refresh_tokens");
    const ins = `INSERT INTO instinct_refresh_tokens (id, user_id, family_id, expires_at, used_at) VALUES ($1,$2,$3, now() + interval '7 days', $4)`;
    await db.query(ins, [LEAKED, "u-cto", FAM, new Date()]); // rotated away
    await db.query(ins, [ROTATED, "u-cto", FAM, null]); // the live head
    await db.query(ins, [OTHER, "u-cto", FAM_OTHER, null]); // another device
  });

  it("plans from a used (already rotated) token: the whole family, head included", async () => {
    const r = await planRevocation(q, { tokenId: LEAKED });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plans.map((p) => [p.familyId, p.unrevoked, p.live])).toEqual([[FAM, 2, 1]]);
  });

  it("revokes only that family, is idempotent, and verifies to zero", async () => {
    const first = await db.query(REVOKE_FAMILY, [FAM]);
    expect(first.rowCount).toBe(2);
    const second = await db.query(REVOKE_FAMILY, [FAM]);
    expect(second.rowCount).toBe(0);
    expect(await countUnrevoked(q, [FAM])).toBe(0);
    expect(await countUnrevoked(q, [FAM_OTHER])).toBe(1);
  });

  it("--user-id finds every live family for the user", async () => {
    const r = await planRevocation(q, { userId: "u-cto" });
    expect(r.ok && r.plans.map((p) => p.familyId).sort()).toEqual([FAM, FAM_OTHER].sort());
    await db.query(REVOKE_FAMILY, [FAM]);
    const after = await planRevocation(q, { userId: "u-cto" });
    expect(after.ok && after.plans.map((p) => p.familyId)).toEqual([FAM_OTHER]);
  });
});
