/** Canary logins (migration 304) on a real Postgres: idempotent over 251, the
 *  widened kind check, idempotent minting per origin, exact lookup. Skipped
 *  unless TEST_DATABASE_URL. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { requireLocalTestDatabase } from "./db-test-safety";
import { findCanaryLogin, mintCanaryLogin } from "@/lib/forcefield/canary-login";

const URL = process.env.TEST_DATABASE_URL;
const describeIfDb = URL ? describe : describe.skip;
const read = (f: string) => readFileSync(join(__dirname, "..", "migrations", f), "utf8");

describeIfDb("canary logins (migration 304)", () => {
  let db: Client;
  const q = (t: string, p: unknown[]) => db.query(t, p) as never;
  beforeAll(async () => {
    db = new Client({ connectionString: requireLocalTestDatabase(URL) });
    await db.connect();
    await db.query("CREATE EXTENSION IF NOT EXISTS pgcrypto");
    await db.query(read("251_forcefield_canaries.sql"));
    await db.query(read("304_forcefield_canary_logins.sql"));
    await db.query(read("304_forcefield_canary_logins.sql")); // idempotent
  });
  afterAll(async () => { await db?.end(); });
  beforeEach(async () => { await db.query("TRUNCATE instinct_forcefield_canaries"); });

  it("a login canary is allowed; an unknown kind is still refused", async () => {
    await db.query("INSERT INTO instinct_forcefield_canaries (workspace_id, kind, value, seeded_in) VALUES ('ws','login','svc_sync_abcdef','login:site=s;decoy=/x;sig=1')");
    await expect(db.query("INSERT INTO instinct_forcefield_canaries (workspace_id, kind, value, seeded_in) VALUES ('ws','other','v','x')")).rejects.toThrow(/kind_chk/);
  });

  it("minting twice for the same origin returns the same canary, a different session gets a new one", async () => {
    const o = { site: "ogiam.com", decoy: "/_ff/registry-a", sig: "s1" };
    const a = await mintCanaryLogin(o, { q, workspaceId: "ws" });
    const b = await mintCanaryLogin(o, { q, workspaceId: "ws" });
    const c = await mintCanaryLogin({ ...o, sig: "s2" }, { q, workspaceId: "ws" });
    expect(a).not.toBeNull();
    expect(b).toEqual(a);
    expect(c?.username).not.toBe(a?.username);
    expect((await db.query("SELECT count(*)::int AS n FROM instinct_forcefield_canaries WHERE kind='login'")).rows[0].n).toBe(2);
  });

  it("an exact lookup finds it with its origin; an inactive one is not found", async () => {
    const a = await mintCanaryLogin({ site: "ogiam.com", decoy: "/_ff/x", sig: "s1" }, { q, workspaceId: "ws" });
    expect(await findCanaryLogin(a!.username, q)).toMatchObject({ origin: { site: "ogiam.com", decoy: "/_ff/x", sig: "s1" } });
    await db.query("UPDATE instinct_forcefield_canaries SET active = false");
    expect(await findCanaryLogin(a!.username, q)).toBeNull();
  });
});
