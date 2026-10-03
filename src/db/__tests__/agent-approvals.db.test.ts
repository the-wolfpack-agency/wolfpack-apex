/** @jest-environment node
 *
 * Real-Postgres test of the money-moving approvals store: the ATOMIC double-
 * approve guard, workspace isolation, and the expiry guard. The route's contract
 * tests mock query(); only a real DB proves the SQL's claim-once semantics - the
 * property that stops an agent write from executing twice. Runs verbatim store
 * SQL so it tracks the real statements. Skipped unless TEST_DATABASE_URL is set
 * (the "SQL against a real Postgres" CI job provides it), like every *.db.test.ts.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { requireLocalTestDatabase } from "./db-test-safety";

const URL = process.env.TEST_DATABASE_URL;
const describeIfDb = URL ? describe : describe.skip;
const MIGRATION = join(__dirname, "..", "migrations", "179_agent_pending_approvals.sql");

// Verbatim from src/lib/agents/approvals/store.ts.
const INSERT = `INSERT INTO instinct_agent_pending_approvals
         (workspace_id, agent_id, owner_user_id, tool, params, capability, decision_seq, expires_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7, now() + ($8 || ' hours')::interval)
       RETURNING id`;
const DECIDE = `UPDATE instinct_agent_pending_approvals
        SET status = $4, decided_by = $3, decided_at = now()
      WHERE id = $1 AND workspace_id = $2 AND status = 'pending' AND expires_at > now()
      RETURNING id`;
const GET = `SELECT id, status FROM instinct_agent_pending_approvals WHERE id = $1 AND workspace_id = $2`;

describeIfDb("instinct_agent_pending_approvals (real Postgres, migration 179)", () => {
  let db: Client;
  beforeAll(async () => {
    db = new Client({ connectionString: requireLocalTestDatabase(URL) });
    await db.connect();
    await db.query(readFileSync(MIGRATION, "utf8"));
  });
  afterAll(async () => { await db?.end(); });
  beforeEach(async () => { await db.query("DELETE FROM instinct_agent_pending_approvals"); });

  const insertPending = async (ws = "w1", hours = "24"): Promise<string> => {
    const { rows } = await db.query(INSERT, [ws, "a1", "owner1", "ai_code.open_pr", JSON.stringify({ repo: "o/r" }), "code.write", null, hours]);
    return rows[0].id;
  };

  it("round-trips a pending approval, visible only in its own workspace", async () => {
    const id = await insertPending("w1");
    expect((await db.query(GET, [id, "w1"])).rows[0].status).toBe("pending");
    expect((await db.query(GET, [id, "w2"])).rowCount).toBe(0); // isolation
  });

  it("ATOMIC double-approve guard: a pending approval is claimed exactly ONCE", async () => {
    const id = await insertPending("w1");
    const first = await db.query(DECIDE, [id, "w1", "user1", "approved"]);
    expect(first.rowCount).toBe(1); // first claim wins
    const second = await db.query(DECIDE, [id, "w1", "user2", "approved"]);
    expect(second.rowCount).toBe(0); // guard holds -> no double-execute
    expect((await db.query(GET, [id, "w1"])).rows[0].status).toBe("approved");
  });

  it("cannot decide another workspace's approval", async () => {
    const id = await insertPending("w1");
    expect((await db.query(DECIDE, [id, "w2", "user1", "approved"])).rowCount).toBe(0);
  });

  it("an EXPIRED approval can no longer be decided (expires_at guard)", async () => {
    const id = await insertPending("w1", "-1"); // expires_at one hour in the past
    expect((await db.query(DECIDE, [id, "w1", "user1", "approved"])).rowCount).toBe(0);
    expect((await db.query(GET, [id, "w1"])).rows[0].status).toBe("pending"); // untouched
  });
});
