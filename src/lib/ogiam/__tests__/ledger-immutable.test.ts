/**
 * ledger-immutable.test.ts
 *
 * Tamper-evidence for the OGIAM governance ledger. Two guarantees, mirroring
 * audit-log-immutable.test.ts:
 *
 *   1. Migration 177 installs a BEFORE UPDATE OR DELETE trigger on BOTH
 *      ogiam_decisions and ogiam_action_outcomes that raises, so the record an
 *      agent is judged against cannot be rewritten or deleted after the fact.
 *   2. The ledger library only ever INSERTs into those tables, so the trigger
 *      never fires at runtime (verified by a static scan AND a behavioural
 *      simulation where the client refuses UPDATE/DELETE).
 *
 * No live Postgres in unit tests, so we combine a migration parse, a source
 * scan, and a simulated client.
 */

import { readFileSync, readdirSync } from "fs";
import { join } from "path";

const REPO = join(__dirname, "..", "..", "..", "..");
const MIGRATIONS_DIR = join(REPO, "src", "db", "migrations");
const LEDGER_LIB = join(REPO, "src", "lib", "ogiam", "ledger.ts");
const MIGRATION = join(
  REPO,
  "src",
  "db",
  "migrations",
  "177_ogiam_immutability_triggers.sql",
);

describe("OGIAM ledger append-only enforcement - static checks", () => {
  const libSource = readFileSync(LEDGER_LIB, "utf8");
  const migrationSource = readFileSync(MIGRATION, "utf8");

  it("the ledger library never issues UPDATE against either OGIAM table", () => {
    expect(libSource).not.toMatch(/UPDATE\s+ogiam_decisions/i);
    expect(libSource).not.toMatch(/UPDATE\s+ogiam_action_outcomes/i);
  });

  it("the ledger library never issues DELETE against either OGIAM table", () => {
    expect(libSource).not.toMatch(/DELETE\s+FROM\s+ogiam_decisions/i);
    expect(libSource).not.toMatch(/DELETE\s+FROM\s+ogiam_action_outcomes/i);
  });

  it("migration 177 defines the immutability trigger function that raises", () => {
    expect(migrationSource).toMatch(
      /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+ogiam_ledger_immutable/i,
    );
    expect(migrationSource).toMatch(/RAISE\s+EXCEPTION/i);
  });

  it("migration 177 installs BEFORE UPDATE OR DELETE on ogiam_decisions", () => {
    expect(migrationSource).toMatch(
      /CREATE\s+TRIGGER\s+ogiam_decisions_no_update[\s\S]*BEFORE\s+UPDATE\s+OR\s+DELETE\s+ON\s+ogiam_decisions/i,
    );
  });

  it("migration 177 installs BEFORE UPDATE OR DELETE on ogiam_action_outcomes", () => {
    expect(migrationSource).toMatch(
      /CREATE\s+TRIGGER\s+ogiam_action_outcomes_no_update[\s\S]*BEFORE\s+UPDATE\s+OR\s+DELETE\s+ON\s+ogiam_action_outcomes/i,
    );
  });

  it("migration 177 is idempotent (DROP TRIGGER IF EXISTS guards)", () => {
    expect(migrationSource).toMatch(/DROP\s+TRIGGER\s+IF\s+EXISTS/i);
    expect(migrationSource).toMatch(/CREATE\s+OR\s+REPLACE\s+FUNCTION/i);
  });
});

/**
 * Coverage guard: every append-only ledger table MUST be defended by a
 * database-level immutability trigger SOMEWHERE in the migration set, not just
 * by an application promise. This is the repo-idiomatic stand-in for a live-DB
 * CI assertion: it catches a future ledger table shipped without a trigger
 * (the exact gap migration 177 just closed for the OGIAM tables). Add the table
 * to this list when a new append-only ledger is introduced.
 */
describe("append-only ledger immutability coverage", () => {
  const APPEND_ONLY_LEDGER_TABLES = [
    "instinct_audit_log",
    "ogiam_decisions",
    "ogiam_action_outcomes",
  ];

  const allMigrations = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql") && !f.endsWith(".down.sql"))
    .map((f) => readFileSync(join(MIGRATIONS_DIR, f), "utf8"))
    .join("\n");

  it.each(APPEND_ONLY_LEDGER_TABLES)(
    "%s has a BEFORE UPDATE OR DELETE immutability trigger",
    (table) => {
      const re = new RegExp(
        `CREATE\\s+TRIGGER\\s+\\w+[\\s\\S]*?BEFORE\\s+UPDATE\\s+OR\\s+DELETE\\s+ON\\s+${table}\\b`,
        "i",
      );
      expect(allMigrations).toMatch(re);
    },
  );
});

// ---------------------------------------------------------------------------
// Behavioural simulation - the client refuses UPDATE/DELETE on the OGIAM
// tables; both ledger writers still complete because they only INSERT.
// ---------------------------------------------------------------------------
const mockConnect = jest.fn();
jest.mock("@/lib/db", () => ({
  pool: { connect: (...a: unknown[]) => mockConnect(...a) },
}));
jest.mock("@/lib/analytics", () => ({ trackEvent: jest.fn() }));

import { recordDecision, recordActionOutcome } from "@/lib/ogiam/ledger";
import type { OgiamAction, OgiamDecision, OgiamPrincipal } from "@/lib/ogiam/types";

const FORBIDDEN =
  /UPDATE\s+ogiam_decisions|DELETE\s+FROM\s+ogiam_decisions|UPDATE\s+ogiam_action_outcomes|DELETE\s+FROM\s+ogiam_action_outcomes/i;

const principal: OgiamPrincipal = {
  kind: "ai_agent",
  agent: "instinct.assistant",
  onBehalfOfUserId: "user-1",
  onBehalfOfRole: "ceo",
  workspaceId: "ws-1",
};

function decisionInput() {
  const action: OgiamAction = {
    tool: "get_calendar",
    capability: "*",
    isMutation: false,
    surface: "/assistant",
    paramsHash: "ph",
    signals: {},
  };
  const decision: OgiamDecision = {
    intendedOutcome: "allow",
    effectiveOutcome: "monitor",
    enforced: false,
    mode: "monitor",
    riskTier: "low",
    policyVersion: "ogiam-test.1",
    ruleId: "R-DEFAULT-ALLOW",
    reason: "ok",
    wouldBlock: false,
  };
  return { principal, action, decision, redactedParams: "{}" };
}

/** A client that throws if any UPDATE/DELETE on the OGIAM tables is attempted,
 *  exactly as the migration-177 trigger would at the database layer. */
function refusingClient() {
  const seen: string[] = [];
  return {
    seen,
    release: jest.fn(),
    query: jest.fn(async (sql: string) => {
      seen.push(String(sql));
      if (FORBIDDEN.test(String(sql))) {
        throw new Error("ogiam ledger is append-only; mutation denied");
      }
      if (/^\s*SELECT seq, entry_hash/i.test(sql)) return { rows: [] };
      if (/^\s*INSERT INTO ogiam_decisions/i.test(sql)) return { rows: [{ id: "dec-1" }] };
      return { rows: [] };
    }),
  };
}

const ORIGINAL_DB_URL = process.env.DATABASE_URL;
beforeEach(() => {
  mockConnect.mockReset();
  process.env.DATABASE_URL = "postgres://test";
});
afterAll(() => {
  if (ORIGINAL_DB_URL === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = ORIGINAL_DB_URL;
});

describe("simulated trigger enforcement", () => {
  it("recordDecision completes via INSERT only, never UPDATE/DELETE", async () => {
    const client = refusingClient();
    mockConnect.mockResolvedValueOnce(client);

    const out = await recordDecision(decisionInput());
    expect(out).toMatchObject({ seq: 1 });
    expect(client.seen.some((s) => FORBIDDEN.test(s))).toBe(false);
    expect(client.seen.some((s) => /^\s*INSERT INTO ogiam_decisions/i.test(s))).toBe(true);
  });

  it("recordActionOutcome completes via INSERT only, never UPDATE/DELETE", async () => {
    const client = refusingClient();
    mockConnect.mockResolvedValueOnce(client);

    await recordActionOutcome({
      workspaceId: "ws-1",
      decisionSeq: 1,
      agentId: "agent-1",
      ok: true,
      code: "ok",
      resultRedacted: "done",
      durationMs: 12,
    });

    expect(client.seen.some((s) => FORBIDDEN.test(s))).toBe(false);
    expect(
      client.seen.some((s) => /^\s*INSERT INTO ogiam_action_outcomes/i.test(s)),
    ).toBe(true);
  });
});
