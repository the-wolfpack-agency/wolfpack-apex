/**
 * audit-log-immutable.test.ts
 *
 * Two guarantees enforced here:
 *
 *  1. The migration SQL installs a BEFORE UPDATE/DELETE trigger that raises.
 *  2. Our own code in `@/lib/audit-log` never emits UPDATE or DELETE against
 *     the table (otherwise the trigger would fire at runtime).
 *
 * We can't run a real Postgres in unit tests, so we combine:
 *   - a static source-scan of `audit-log.ts`
 *   - a parse of migration 019 to assert the trigger + function exist
 *   - a simulation: a mock client that throws when UPDATE/DELETE is attempted,
 *     and a check that recordAudit survives (never triggers the error).
 */

 

import { readFileSync } from "fs";
import { join } from "path";

const REPO = join(__dirname, "..", "..", "..");
const AUDIT_LIB = join(REPO, "src", "lib", "audit-log.ts");
const MIGRATION = join(REPO, "src", "db", "migrations", "019_audit_log.sql");

describe("audit log append-only enforcement — static checks", () => {
  const libSource = readFileSync(AUDIT_LIB, "utf8");
  const migrationSource = readFileSync(MIGRATION, "utf8");

  it("the audit-log library never issues UPDATE on instinct_audit_log", () => {
    expect(libSource).not.toMatch(/UPDATE\s+instinct_audit_log/i);
  });

  it("the audit-log library never issues DELETE on instinct_audit_log", () => {
    expect(libSource).not.toMatch(/DELETE\s+FROM\s+instinct_audit_log/i);
  });

  it("migration 019 defines audit_log_immutable trigger function", () => {
    expect(migrationSource).toMatch(
      /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+audit_log_immutable/i,
    );
    expect(migrationSource).toMatch(/RAISE\s+EXCEPTION/i);
  });

  it("migration 019 installs BEFORE UPDATE OR DELETE trigger", () => {
    expect(migrationSource).toMatch(
      /CREATE\s+TRIGGER\s+audit_log_no_update[\s\S]*BEFORE\s+UPDATE\s+OR\s+DELETE\s+ON\s+instinct_audit_log/i,
    );
  });

  it("migration 019 uses idempotent guards (IF NOT EXISTS / IF EXISTS)", () => {
    expect(migrationSource).toMatch(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS/i);
    expect(migrationSource).toMatch(/DROP\s+TRIGGER\s+IF\s+EXISTS/i);
  });
});

// ---------------------------------------------------------------------------
// Behavioural simulation — mock client refuses UPDATE/DELETE, recordAudit OK
// ---------------------------------------------------------------------------
const mockConnect = jest.fn();
jest.mock("@/lib/db", () => ({
  pool: { connect: (...args: unknown[]) => mockConnect(...args) },
  // activePool() replaced direct pool use so every query is routed to the
  // tenant's database. The mock must expose it or the module under test
  // calls undefined.
  activePool: () => ({ connect: (...args: unknown[]) => mockConnect(...args) }),
  query: jest.fn(),
  safeQuery: jest.fn(),
}));
jest.mock("@/lib/analytics", () => ({ trackEvent: jest.fn() }));

import { recordAudit } from "@/lib/audit-log";

describe("simulated trigger enforcement", () => {
  beforeAll(() => {
    process.env.DATABASE_URL = "postgres://test";
  });

  it("recordAudit never issues UPDATE/DELETE against instinct_audit_log", async () => {
    const seenSql: string[] = [];
    const client = {
      query: jest.fn(async (sql: string, _params?: unknown[]) => {
        seenSql.push(String(sql));
        if (/UPDATE\s+instinct_audit_log|DELETE\s+FROM\s+instinct_audit_log/i.test(String(sql))) {
          throw new Error("instinct_audit_log is append-only — UPDATE denied");
        }
        if (String(sql).includes("SELECT entry_hash")) return { rows: [] };
        if (String(sql).includes("nextval")) return { rows: [{ nextval: "1" }] };
        if (String(sql).includes("INSERT INTO instinct_audit_log")) return { rows: [{ id: "uuid-x" }] };
        return { rows: [] };
      }),
      release: jest.fn(),
    };
    mockConnect.mockResolvedValueOnce(client);

    await expect(
      recordAudit({
        actor: { user_id: "u1", role: "cto" },
        action: "a.b",
        resourceType: "r",
      }),
    ).resolves.toMatchObject({ seq: 1, id: "uuid-x" });

    const forbidden = seenSql.some((s) =>
      /UPDATE\s+instinct_audit_log|DELETE\s+FROM\s+instinct_audit_log/i.test(s),
    );
    expect(forbidden).toBe(false);
  });
});
