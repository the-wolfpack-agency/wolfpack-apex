/**
 * The hold that had never held anything, run against a real Postgres.
 *
 * agent.write_pending_approval, agent.write_approved and agent.write_executed
 * had never fired. Not once, in ninety days, while /playbook told clients the
 * product holds an agent's write until a human approves it. The store was
 * written and unit tested; nothing outside its own tests ever called it.
 *
 * Unit tests could not have closed that gap, and this is the point. They mock
 * `query`, so they assert we send the SQL we meant to send, which is exactly
 * the thing that can be wrong. This suite runs the real lifecycle against a
 * real database with the schema built from the real migrations: hold, appear
 * as pending, get decided, get executed. If any statement names a column that
 * does not exist, it fails here and only here.
 *
 * Skipped unless TEST_DATABASE_URL is set, and requireLocalTestDatabase
 * refuses anything that is not local.
 *
 *   docker run --rm -d -p 55995:5432 -e POSTGRES_PASSWORD=test --name pgtest postgres:16-alpine
 *   TEST_DATABASE_URL=postgresql://postgres:test@127.0.0.1:55995/postgres npx jest write-approval-hold
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { requireLocalTestDatabase } from "@/db/__tests__/db-test-safety";

const URL = process.env.TEST_DATABASE_URL;
const d = URL ? describe : describe.skip;

const MIGRATIONS = join(__dirname, "..", "..", "..", "..", "db", "migrations");

const WS = "ws-hold";
const OWNER = "owner-1";
/* Real UUIDs: instinct_agents.id is a uuid column, and the string ids this
   test first used were rejected by Postgres. Exactly the class of mistake a
   mocked `query` cannot catch. */
const HELD_AGENT = "11111111-1111-4111-8111-111111111111";
const FREE_AGENT = "22222222-2222-4222-8222-222222222222";
const UNKNOWN_AGENT = "33333333-3333-4333-8333-333333333333";

d("an agent write is actually held", () => {
  let db: Client;

  const savedDbUrl = process.env.DATABASE_URL;

  beforeAll(async () => {
    /* The store checks process.env.DATABASE_URL directly before writing, so
       the mocked client alone is not enough. Worth knowing rather than working
       around: with it unset the hold returns a refusal, which is the correct
       fail-closed answer, and this suite is here to exercise the path where it
       is set. */
    process.env.DATABASE_URL = requireLocalTestDatabase(URL);
    db = new Client({ connectionString: requireLocalTestDatabase(URL) });
    await db.connect();

    /* Schema from the real migrations, not a hand-written approximation. A
       table shaped by the test proves only that the test agrees with itself. */
    for (const file of [
      "171_agent_principals.sql",
      "179_agent_pending_approvals.sql",
      "242_agent_write_approval.sql",
    ]) {
      await db.query(readFileSync(join(MIGRATIONS, file), "utf8"));
    }

    /* Idempotent: the throwaway database may already carry these from an
       earlier run, and a suite that only passes on a pristine container is a
       suite that fails for the wrong reason. */
    await db.query(`DELETE FROM instinct_agents WHERE workspace_id = $1`, [WS]);
    await db.query(
      `INSERT INTO instinct_agents
         (id, workspace_id, name, role, owner_user_id, created_by, requires_write_approval)
       VALUES ($1,$2,'Held agent','dev',$3,$3, TRUE),
              ($4,$2,'Free agent','dev',$3,$3, FALSE)`,
      [HELD_AGENT, WS, OWNER, FREE_AGENT],
    );
  }, 60_000);

  afterAll(async () => {
    if (savedDbUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = savedDbUrl;
    await db?.end().catch(() => undefined);
  });

  beforeEach(async () => {
    await db.query("DELETE FROM instinct_agent_pending_approvals");
    jest.resetModules();
  });

  async function mod() {
    jest.doMock("@/lib/db", () => ({
      query: (text: string, params?: unknown[]) => db.query(text, params as never),
      /* The store reads through safeQuery as well as query. Mocking only one
         of them left the read paths throwing while the writes succeeded. */
      safeQuery: async (text: string, params?: unknown[]) => {
        try {
          const r = await db.query(text, params as never);
          return { rows: r.rows, fromCache: false };
        } catch {
          return { rows: [], fromCache: false };
        }
      },
      hasDatabase: () => true,
    }));
    return {
      gate: await import("@/lib/agents/approvals/gate"),
      store: await import("@/lib/agents/approvals/store"),
    };
  }

  const write = (agentId: string) => ({
    agentId,
    workspaceId: WS,
    ownerUserId: OWNER,
    operationId: "draft_email",
    method: "POST",
    params: { to: "someone@example.com" },
    capability: "mail.send",
  });

  it("holds a write from an agent that requires approval", async () => {
    const { gate } = await mod();
    const held = await gate.holdWriteForApproval(write(HELD_AGENT));
    expect(held).not.toBeNull();
    expect(held!.approvalId).not.toBe("");
    expect(held!.detail).toMatch(/has not run/i);
  });

  /* The row is the whole point. A hold that returns a message and records
     nothing leaves nobody able to approve it. */
  it("leaves a pending row somebody can actually act on", async () => {
    const { gate, store } = await mod();
    const held = await gate.holdWriteForApproval(write(HELD_AGENT));
    const pending = await store.listPendingApprovals(WS);
    expect(pending.map((p) => p.id)).toContain(held!.approvalId);
  });

  /* Gating every write would stop the seventy-three tasks that already run
     here and teach everybody to switch the gate off. */
  it("lets an agent without the flag write straight through", async () => {
    const { gate } = await mod();
    expect(await gate.holdWriteForApproval(write(FREE_AGENT))).toBeNull();
  });

  /* A read that needed approval would make the gate hated, and a hated gate
     becomes a rubber stamp. */
  it("never holds a read", async () => {
    const { gate } = await mod();
    expect(
      await gate.holdWriteForApproval({ ...write(HELD_AGENT), method: "GET" }),
    ).toBeNull();
  });

  it.each(["POST", "PUT", "PATCH", "DELETE"])("holds a %s", async (method) => {
    const { gate } = await mod();
    expect(
      await gate.holdWriteForApproval({ ...write(HELD_AGENT), method }),
    ).not.toBeNull();
  });

  /* FAILS CLOSED ON AN UNKNOWN ACTOR. Everywhere else an unreadable source
     degrades to "we do not know" and carries on. Here the cost is an
     unapproved write against a client's system. */
  it("holds a write from an agent it does not recognize", async () => {
    const { gate } = await mod();
    const held = await gate.holdWriteForApproval(write(UNKNOWN_AGENT));
    expect(held).not.toBeNull();
  });

  it("holds a write from an agent belonging to another workspace", async () => {
    const { gate } = await mod();
    const held = await gate.holdWriteForApproval({
      ...write(HELD_AGENT),
      workspaceId: "someone-elses-workspace",
    });
    expect(held).not.toBeNull();
  });

  describe("the decision", () => {
    /* The signature is (id, workspaceId, decidedBy, decision). Written first
       with the last two transposed, which sent "approved" into decided_by and
       an actor id into status, and Postgres refused it on the status CHECK.
       A mocked query would have accepted both happily. */
    it("records an approval and can then be marked executed", async () => {
      const { gate, store } = await mod();
      const held = await gate.holdWriteForApproval(write(HELD_AGENT));

      const decided = await store.decidePendingApproval(
        held!.approvalId,
        WS,
        OWNER,
        "approved",
      );
      expect(decided?.status).toBe("approved");
      expect(decided?.decidedBy).toBe(OWNER);

      await store.markApprovalExecuted(held!.approvalId, WS, { ok: true });
      const after = await store.getPendingApproval(held!.approvalId, WS);
      expect(after?.status).toBe("executed");
    });

    it("records a refusal", async () => {
      const { gate, store } = await mod();
      const held = await gate.holdWriteForApproval(write(HELD_AGENT));
      const decided = await store.decidePendingApproval(held!.approvalId, WS, OWNER, "rejected");
      expect(decided?.status).toBe("rejected");
    });

    /* One workspace deciding another's approvals would make the whole control
       decorative in a multi-tenant deployment. */
    it("will not let another workspace decide it", async () => {
      const { gate, store } = await mod();
      const held = await gate.holdWriteForApproval(write(HELD_AGENT));
      expect(
        await store.decidePendingApproval(held!.approvalId, "other-ws", OWNER, "approved"),
      ).toBeNull();
      const after = await store.getPendingApproval(held!.approvalId, WS);
      expect(after?.status).toBe("pending");
    });

    /* Approve, then reject, would otherwise overwrite a decision somebody
       already acted on. */
    it("does not let the same approval be decided twice", async () => {
      const { gate, store } = await mod();
      const held = await gate.holdWriteForApproval(write(HELD_AGENT));
      expect(
        (await store.decidePendingApproval(held!.approvalId, WS, OWNER, "approved"))?.status,
      ).toBe("approved");
      expect(
        await store.decidePendingApproval(held!.approvalId, WS, OWNER, "rejected"),
      ).toBeNull();
    });
  });
});
