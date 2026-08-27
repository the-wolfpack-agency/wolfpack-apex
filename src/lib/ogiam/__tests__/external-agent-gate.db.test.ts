/**
 * The external agent key store, against a REAL Postgres.
 *
 * WHY THIS EXISTS. The bring-your-own-agent gate is the strongest claim this
 * product makes: any agent, on any framework, authenticates and asks the gate
 * before it acts. On 2026-08-27 the table holding those keys had ZERO rows.
 * Not one external agent had ever called it. The endpoint, the key store, the
 * rate limiter and the capability scoping were each tested in isolation with a
 * mocked `query`, which asserts we send the SQL we meant to send. That is
 * exactly the thing that can be wrong.
 *
 * This repo has been bitten by that precise gap before: the invite upsert named
 * a constraint that could never exist, every new invitee was turned away, and
 * no unit test could have caught it because none of them ran SQL.
 *
 * So this executes the real key lifecycle against a live server, with the
 * schema built from the real migration file. A column that does not exist, a
 * hash comparison that never matches, a revocation that does not bite: each
 * fails here and only here.
 *
 * Skipped unless TEST_DATABASE_URL is set, and requireLocalTestDatabase
 * refuses anything that is not local. Never point this at a hosted database:
 * it creates and revokes credentials.
 *
 *   docker run --rm -d -p 55997:5432 -e POSTGRES_PASSWORD=test --name pgtest postgres:16-alpine
 *   TEST_DATABASE_URL=postgresql://postgres:test@127.0.0.1:55997/postgres npx jest external-agent-gate
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { requireLocalTestDatabase } from "@/db/__tests__/db-test-safety";

const URL = process.env.TEST_DATABASE_URL;
const d = URL ? describe : describe.skip;

const MIGRATIONS = join(__dirname, "..", "..", "..", "db", "migrations");

d("the external agent key store, against real SQL", () => {
  let db: Client;

  beforeAll(async () => {
    const safe = requireLocalTestDatabase(URL);
    db = new Client({ connectionString: safe });
    await db.connect();

    /* Schema from the real migration, not a hand-written approximation. A
       table shaped by the test rather than by the migration proves only that
       the test agrees with itself. */
    await db.query(readFileSync(join(MIGRATIONS, "201_gate_api_keys.sql"), "utf8"));
  }, 60_000);

  afterAll(async () => {
    await db?.end().catch(() => undefined);
  });

  beforeEach(async () => {
    await db.query("DELETE FROM instinct_gate_api_keys");
    jest.resetModules();
  });

  /** The real module, wired to this throwaway database. */
  async function keys() {
    jest.doMock("@/lib/db", () => ({
      query: (text: string, params?: unknown[]) => db.query(text, params as never),
    }));
    return import("@/lib/ogiam/api-keys");
  }

  it("mints a key that verifies, and stores no plaintext anywhere", async () => {
    const { createApiKey, verifyApiKey } = await keys();
    const made = await createApiKey({
      workspaceId: "ws1",
      agent: "acme.qa-bot",
      capabilities: ["brain.read"],
      createdBy: "u1",
    });

    expect((await verifyApiKey(made.plaintextKey)).ok).toBe(true);

    /* THE PLAINTEXT MUST NOT SURVIVE. A key readable from the table is a key
       readable by anybody who can read the table. */
    const { rows } = await db.query<{ key_hash: string; key_prefix: string }>(
      "SELECT key_hash, key_prefix FROM instinct_gate_api_keys",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].key_hash).not.toBe(made.plaintextKey);
    expect(rows[0].key_hash).not.toContain(made.plaintextKey);
  });

  /* The reason is part of the contract, not a detail. "Never issued" and
     "revoked an hour ago" are different incidents, and a caller that cannot
     tell them apart cannot tell a probe from a leak. */
  it("refuses a key it never issued, and says why", async () => {
    const { verifyApiKey } = await keys();
    expect(await verifyApiKey("ogk_a_key_that_was_never_minted")).toEqual({
      ok: false,
      reason: "not_found",
    });
  });

  /* A leaked key stays useful for exactly as long as revocation does not bite,
     so this is the assertion that decides how bad a leak is. */
  it("stops accepting a key the moment it is revoked", async () => {
    const { createApiKey, verifyApiKey, revokeApiKey } = await keys();
    const made = await createApiKey({
      workspaceId: "ws1",
      agent: "acme.qa-bot",
      capabilities: ["brain.read"],
      createdBy: "u1",
    });
    expect((await verifyApiKey(made.plaintextKey)).ok).toBe(true);

    expect(await revokeApiKey(made.id, "ws1")).toBe(true);
    expect(await verifyApiKey(made.plaintextKey)).toEqual({ ok: false, reason: "revoked" });
  });

  /* Revoking twice must not report a second success: an operator reading
     "revoked" a second time would think they had just closed something. */
  it("reports a second revocation as a no-op", async () => {
    const { createApiKey, revokeApiKey } = await keys();
    const made = await createApiKey({
      workspaceId: "ws1",
      agent: "acme.qa-bot",
      capabilities: ["brain.read"],
      createdBy: "u1",
    });
    expect(await revokeApiKey(made.id, "ws1")).toBe(true);
    expect(await revokeApiKey(made.id, "ws1")).toBe(false);
  });

  /* Tenancy. One workspace must not be able to revoke another's credentials. */
  it("will not let one workspace revoke another's key", async () => {
    const { createApiKey, revokeApiKey, verifyApiKey } = await keys();
    const made = await createApiKey({
      workspaceId: "ws1",
      agent: "acme.qa-bot",
      capabilities: ["brain.read"],
      createdBy: "u1",
    });
    expect(await revokeApiKey(made.id, "ws2")).toBe(false);
    expect((await verifyApiKey(made.plaintextKey)).ok).toBe(true);
  });

  it("carries the capability allowlist through to verification", async () => {
    const { createApiKey, verifyApiKey } = await keys();
    const made = await createApiKey({
      workspaceId: "ws1",
      agent: "acme.qa-bot",
      capabilities: ["brain.read", "tasks.view"],
      createdBy: "u1",
    });
    const verified = await verifyApiKey(made.plaintextKey);
    if (!verified.ok) throw new Error(`expected a usable key, got ${verified.reason}`);
    expect(verified.capabilities).toEqual(expect.arrayContaining(["brain.read", "tasks.view"]));
    expect(verified.capabilities).not.toContain("settings.manage_team");
  });

  /* THE PEPPER HAS TO MATTER, or it is decoration. A stored hash must not be
     verifiable by someone holding the table but not the server secret. */
  it("cannot verify a key when the pepper changes", async () => {
    const saved = process.env.GATE_KEY_PEPPER;
    process.env.GATE_KEY_PEPPER = "pepper-one";
    const { createApiKey } = await keys();
    const made = await createApiKey({
      workspaceId: "ws1", agent: "acme.qa-bot", capabilities: ["brain.read"], createdBy: "u1",
    });

    /* Same row, same plaintext, different server secret. */
    jest.resetModules();
    process.env.GATE_KEY_PEPPER = "pepper-two";
    const { verifyApiKey } = await keys();
    expect(await verifyApiKey(made.plaintextKey)).toEqual({ ok: false, reason: "not_found" });

    if (saved === undefined) delete process.env.GATE_KEY_PEPPER;
    else process.env.GATE_KEY_PEPPER = saved;
  });

  /* A digest stored without a secret can be confirmed offline by anybody
     holding a copy of the table. This asserts the stored value is not one. */
  it("stores a hash that a plain digest of the key does not reproduce", async () => {
    process.env.GATE_KEY_PEPPER = "a-real-pepper";
    jest.resetModules();
    const { createApiKey } = await keys();
    const made = await createApiKey({
      workspaceId: "ws1", agent: "acme.qa-bot", capabilities: ["brain.read"], createdBy: "u1",
    });
    const { createHash } = await import("node:crypto");
    const unpeppered = createHash("sha256").update(made.plaintextKey, "utf8").digest("hex");
    const { rows } = await db.query<{ key_hash: string }>(
      "SELECT key_hash FROM instinct_gate_api_keys",
    );
    expect(rows[0].key_hash).not.toBe(unpeppered);
    delete process.env.GATE_KEY_PEPPER;
  });

  it("keeps two agents' keys apart", async () => {
    const { createApiKey, verifyApiKey } = await keys();
    const a = await createApiKey({
      workspaceId: "ws1", agent: "acme.qa-bot", capabilities: ["brain.read"], createdBy: "u1",
    });
    const b = await createApiKey({
      workspaceId: "ws1", agent: "other.bot", capabilities: ["tasks.view"], createdBy: "u1",
    });
    expect(a.plaintextKey).not.toBe(b.plaintextKey);
    const va = await verifyApiKey(a.plaintextKey);
    const vb = await verifyApiKey(b.plaintextKey);
    if (!va.ok || !vb.ok) throw new Error("expected both keys to verify");
    expect(va.agent).toBe("acme.qa-bot");
    expect(vb.agent).toBe("other.bot");
  });
});
