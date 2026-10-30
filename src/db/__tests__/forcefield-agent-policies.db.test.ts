/** Per-site AI agent policy (migration 303) against a real Postgres: idempotent,
 *  the scope shape is enforced, and the library's upsert/read round-trips.
 *  Skipped unless TEST_DATABASE_URL. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { requireLocalTestDatabase } from "./db-test-safety";
import { getAgentPolicy, setAgentPolicy, siteScope, tenantScope } from "@/lib/forcefield-web/agent-policy";

const URL = process.env.TEST_DATABASE_URL;
const describeIfDb = URL ? describe : describe.skip;
const MIGRATION = join(__dirname, "..", "migrations", "303_forcefield_agent_policies.sql");

describeIfDb("forcefield agent policies (migration 303)", () => {
  let db: Client;
  const q = (text: string, params: unknown[]) => db.query(text, params) as never;
  beforeAll(async () => {
    db = new Client({ connectionString: requireLocalTestDatabase(URL) });
    await db.connect();
    const sql = readFileSync(MIGRATION, "utf8");
    await db.query(sql); await db.query(sql); // idempotent
  });
  afterAll(async () => { await db?.end(); });
  beforeEach(async () => { await db.query("TRUNCATE forcefield_agent_policies"); });

  it("no row: nothing blocked", async () => {
    expect((await getAgentPolicy(siteScope("weekendwithporsche"), q)).blockedAgents).toEqual([]);
  });

  it("set then read, then replace; previous returned for the audit", async () => {
    const t = tenantScope("11111111-2222-3333-4444-555555555555");
    expect(await setAgentPolicy(t, ["GPTBot"], "tenant:x", q)).toEqual({ ok: true, previous: [] });
    expect((await getAgentPolicy(t, q)).blockedAgents).toEqual(["GPTBot"]);
    expect(await setAgentPolicy(t, ["ClaudeBot", "GPTBot"], "tenant:x", q)).toEqual({ ok: true, previous: ["GPTBot"] });
    const { rows } = await db.query("SELECT count(*)::int AS n, max(updated_by) AS by FROM forcefield_agent_policies");
    expect(rows[0]).toEqual({ n: 1, by: "tenant:x" });
  });

  it("the scope shape is enforced by the table, not only the API", async () => {
    await expect(db.query("INSERT INTO forcefield_agent_policies (scope) VALUES ('anything')")).rejects.toThrow(/forcefield_agent_policies_scope_shape/);
    await expect(db.query("INSERT INTO forcefield_agent_policies (scope) VALUES ('site:Has Spaces')")).rejects.toThrow();
  });
});
