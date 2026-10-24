/**
 * Vacuous-pass regressions for the readiness engine.
 *
 * Each fixture is a repo shape that USED to grade "ready" without the control
 * existing: a comment describing a policy, a policy on a different table, a
 * deleted route that is "clean by absence", a placeholder *.db.test.ts, the word
 * "immutable" near "ogiam". Every one must now FAIL to read ready.
 */
import { toolById } from "@/lib/readiness/catalog";
import { reportTool } from "@/lib/readiness/report";
import {
  codeOf,
  hasForcedRls,
  hasImmutabilityTrigger,
  hasSessionVarPolicy,
  isRealDbTest,
  migrationStatements,
  stripJsComments,
  stripSqlComments,
  stripYamlComments,
  tableHasColumn,
} from "@/lib/readiness/scan";
import type { RepoReader } from "@/lib/readiness/types";

function fakeReader(files: Record<string, string>): RepoReader {
  const paths = Object.keys(files);
  return {
    read: (p) => (p in files ? files[p] : null),
    exists: (p) => p in files || paths.some((x) => x.startsWith(p + "/")),
    listFiles: (dir, suffix) => paths.filter((p) => (p === dir || p.startsWith(dir + "/")) && (!suffix || p.endsWith(suffix))),
  };
}

const statusOf = (tool: string, id: string, files: Record<string, string>) =>
  reportTool(toolById(tool)!, fakeReader(files)).results.find((r) => r.id === id)?.status;

const GUARD = { "src/lib/db/__tests__/tenant-isolation-global.test.ts": "guardrail" };

describe("comment stripping keeps code, drops comments", () => {
  it("JS: line + block comments go, strings and regexes stay", () => {
    const out = stripJsComments(`const a = "http://x"; // trackEvent(\n/* recordAudit( */ const r = /\\/\\/ not/; trackEvent2;`);
    expect(out).toContain('"http://x"');
    expect(out).toContain("/\\/\\/ not/");
    expect(out).not.toMatch(/trackEvent\(/);
    expect(out).not.toMatch(/recordAudit\(/);
  });
  it("SQL: -- and block comments go, quoted strings stay", () => {
    const out = stripSqlComments("-- current_setting('app.workspace_id')\nSELECT '--keep' /* x */;");
    expect(out).not.toMatch(/current_setting/);
    expect(out).toContain("'--keep'");
  });
  it("YAML: # comments go, quoted # stays", () => {
    const out = stripYamlComments("on:\n  # pull_request:\nname: 'a # b'");
    expect(out).not.toMatch(/pull_request/);
    expect(out).toContain("'a # b'");
  });
  it("codeOf leaves unknown file types alone", () => {
    expect(codeOf("README.md", "# heading")).toBe("# heading");
  });
});

describe("SQL statement predicates", () => {
  const stmts = (sql: string) => migrationStatements(fakeReader({ "src/db/migrations/1.sql": sql }));
  it("a policy described in a comment is not a policy", () => {
    expect(hasSessionVarPolicy(stmts("-- CREATE POLICY p ON t USING (workspace_id = current_setting('app.workspace_id'))\nSELECT 1;"), "t", "app.workspace_id")).toBe(false);
  });
  it("a USING(true) policy is not a session-var policy", () => {
    expect(hasSessionVarPolicy(stmts("CREATE POLICY p ON t FOR ALL USING (true) WITH CHECK (true);"), "t", "app.workspace_id")).toBe(false);
  });
  it("a real policy on ANOTHER table does not count for this one", () => {
    const s = stmts("CREATE TABLE t(workspace_id text); CREATE POLICY p ON other USING (workspace_id = current_setting('app.workspace_id'));");
    expect(hasSessionVarPolicy(s, "t", "app.workspace_id")).toBe(false);
    expect(hasSessionVarPolicy(s, "other", "app.workspace_id")).toBe(true);
  });
  it("FORCE must be on this table", () => {
    expect(hasForcedRls(stmts("ALTER TABLE other FORCE ROW LEVEL SECURITY;"), "t")).toBe(false);
    expect(hasForcedRls(stmts("ALTER TABLE t ENABLE ROW LEVEL SECURITY;"), "t")).toBe(false);
    expect(hasForcedRls(stmts("ALTER TABLE IF EXISTS t FORCE ROW LEVEL SECURITY;"), "t")).toBe(true);
  });
  it("workspace_id must be a column of this table, not a later mention", () => {
    expect(tableHasColumn(stmts("CREATE TABLE t(id int); CREATE INDEX ON other(workspace_id);"), "t", "workspace_id")).toBe(false);
    expect(tableHasColumn(stmts("ALTER TABLE t ADD COLUMN IF NOT EXISTS workspace_id text;"), "t", "workspace_id")).toBe(true);
  });
  it("an immutability trigger must be a CREATE TRIGGER BEFORE UPDATE/DELETE ON the table", () => {
    expect(hasImmutabilityTrigger(stmts("-- ogiam rows are immutable\nSELECT 1;"), "ogiam_")).toBe(false);
    expect(hasImmutabilityTrigger(stmts("CREATE TRIGGER x AFTER INSERT ON ogiam_decisions FOR EACH ROW EXECUTE FUNCTION f();"), "ogiam_")).toBe(false);
    expect(hasImmutabilityTrigger(stmts("CREATE TRIGGER x BEFORE UPDATE OR DELETE ON ogiam_decisions FOR EACH ROW EXECUTE FUNCTION f();"), "ogiam_")).toBe(true);
  });
});

describe("DB tests must really run against a database", () => {
  it("a placeholder, a mocked db, or a file with no test case is not a DB test", () => {
    const r = fakeReader({
      "a.db.test.ts": "db",
      "b.db.test.ts": "jest.mock('@/lib/db'); const u = process.env.TEST_DATABASE_URL; it('x', () => {});",
      "c.db.test.ts": "// TEST_DATABASE_URL\nit('x', () => {});",
      "d.db.test.ts": "const u = process.env.TEST_DATABASE_URL;",
      "e.db.test.ts": "const u = process.env.TEST_DATABASE_URL; it('persists', async () => {});",
    });
    expect(["a", "b", "c", "d", "e"].map((x) => isRealDbTest(r, `${x}.db.test.ts`))).toEqual([false, false, false, false, true]);
  });
  it("db-tests is a gap when the only DB tests are placeholders", () => {
    expect(statusOf("forcefield", "db-tests", { "src/db/__tests__/forcefield-a.db.test.ts": "db", "src/db/__tests__/forcefield-b.db.test.ts": "db" })).toBe("gap");
  });
});

describe("isolation-db-enforced (the audit's SQL-comment finding)", () => {
  it("FAILS: 196_platform_scan_rls-style comment naming current_setting('app.workspace_id') + USING(true)", () => {
    const files = {
      ...GUARD,
      "src/db/migrations/212_ai_code_reviews.sql": "CREATE TABLE instinct_ai_code_reviews(id uuid, workspace_id text);",
      "src/db/migrations/296_rls.sql":
        "-- a USING (current_setting('app.workspace_id')) policy would deny every query\nALTER TABLE instinct_ai_code_reviews ENABLE ROW LEVEL SECURITY;\nCREATE POLICY instinct_ai_code_reviews_all ON instinct_ai_code_reviews FOR ALL USING (true) WITH CHECK (true);",
    };
    expect(statusOf("ai-code", "isolation-db-enforced", files)).toBe("partial");
  });
  it("FAILS: a real policy without FORCE ROW LEVEL SECURITY (the owner role bypasses it)", () => {
    const files = {
      ...GUARD,
      "src/db/migrations/212.sql":
        "CREATE TABLE instinct_ai_code_reviews(workspace_id text); CREATE POLICY p ON instinct_ai_code_reviews USING (workspace_id = current_setting('app.workspace_id'));",
    };
    expect(statusOf("ai-code", "isolation-db-enforced", files)).toBe("partial");
  });
  it("FAILS: the table name appears before an unrelated workspace_id in the same file", () => {
    const files = { ...GUARD, "src/db/migrations/178.sql": "CREATE TABLE site_analytics_events(id bigserial); CREATE TABLE other(workspace_id text);" };
    expect(statusOf("site-analytics", "isolation-db-enforced", files)).toBe("gap");
  });
  it("forcefield tenant RLS: a comment naming the tenant GUC is not RLS", () => {
    const files = {
      "src/app/api/forcefield/my-stats/route.ts": "resolveTenantByToken(x); tenant.id",
      "src/lib/db/__tests__/tenant-scoping-register.test.ts": "g",
      "src/db/migrations/290.sql": "-- forcefield_tenant_id = current_setting('app.forcefield_tenant')\nSELECT 1;",
    };
    expect(statusOf("forcefield", "token-scoped-isolation", files)).toBe("partial");
  });
});

describe("negative checks are never clean by absence", () => {
  it("no-default-workspace-coalesce: missing routes are not ready", () => {
    expect(statusOf("ai-code", "no-default-workspace-coalesce", {})).toBe("gap");
  });
  it("no-default-workspace-coalesce: a commented-out coalesce is ignored, a real one is caught", () => {
    expect(statusOf("ai-code", "no-default-workspace-coalesce", { "src/app/api/admin/ai-code/r/route.ts": '// x ?? "default"\nconst w = ws;' })).toBe("ready");
    expect(statusOf("ai-code", "no-default-workspace-coalesce", { "src/app/api/admin/ai-code/r/route.ts": "const w = ws ?? 'default';" })).toBe("gap");
  });
  it("audit-calls-guarded: missing routes, or routes that never audit, are not ready", () => {
    expect(statusOf("ai-code", "audit-calls-guarded", {})).toBe("gap");
    expect(statusOf("ai-code", "audit-calls-guarded", { "src/app/api/admin/ai-code/r/route.ts": "run();" })).toBe("gap");
    expect(statusOf("ai-code", "audit-calls-guarded", { "src/app/api/admin/ai-code/r/route.ts": "await recordAuditNonFatal({});" })).toBe("ready");
  });
  it("promote-surface-correct: missing routes are not ready", () => {
    expect(statusOf("site-analytics", "promote-surface-correct", {})).toBe("gap");
  });
  it("site-analytics durable-rate-limit: no in-memory counter is not enough without a durable limiter call", () => {
    expect(statusOf("site-analytics", "durable-rate-limit", {})).toBe("gap");
    expect(statusOf("site-analytics", "durable-rate-limit", { "src/app/api/site-analytics/ingest/route.ts": "ok();" })).toBe("gap");
    expect(statusOf("site-analytics", "durable-rate-limit", { "src/app/api/site-analytics/ingest/route.ts": "await checkRateLimit(k);" })).toBe("ready");
  });
  it("forcefield signup-gated / durable-rate-limit: a missing file is not ready", () => {
    expect(statusOf("forcefield", "signup-gated", {})).toBe("gap");
    expect(statusOf("forcefield", "durable-rate-limit", {})).toBe("gap");
  });
});

describe("mentions are not calls", () => {
  it("observability: a commented trackEvent / recordAudit is a gap", () => {
    expect(statusOf("agent-approvals", "observability", { "src/app/api/admin/agents/r/route.ts": "// trackEvent(x)\n/* recordAudit(y) */\nrun();" })).toBe("gap");
  });
  it("approval-execute-audited: an import alone is not an audit call", () => {
    expect(statusOf("agent-approvals", "approval-execute-audited", { "src/app/api/admin/agents/approvals/r/route.ts": 'import { recordAudit } from "@/lib/audit-log";' })).toBe("gap");
  });
  it("events-perf-indexes: a comment about props->>'site' is not an index", () => {
    expect(statusOf("site-analytics", "events-perf-indexes", { "src/db/migrations/1.sql": "-- index site_analytics_events on props->>'site' later\nCREATE INDEX ON site_analytics_events(created_at);" })).toBe("gap");
    expect(statusOf("site-analytics", "events-perf-indexes", { "src/db/migrations/1.sql": "CREATE INDEX IF NOT EXISTS i ON site_analytics_events ((props->>'site'));" })).toBe("ready");
  });
  it("ledger-hash-chained-immutable: the word immutable near ogiam is not a trigger", () => {
    const files = { "src/lib/ogiam/ledger.ts": "const entry_hash = sha256(x);", "src/db/migrations/177.sql": "-- ogiam ledger rows are immutable\nSELECT 1;" };
    expect(statusOf("ogiam-gate", "ledger-hash-chained-immutable", files)).toBe("partial");
  });
  it("e2e-gates-on-pr: a commented-out pull_request trigger is not a gate", () => {
    const files = {
      ".github/workflows/x.yml": "on:\n  # pull_request:\n  push:\njobs:\n  a:\n    steps:\n      - run: npx playwright test tests/e2e/forcefield-dashboard.spec.ts",
      "tests/e2e/forcefield-dashboard.spec.ts": "test('x', async () => {});",
    };
    expect(statusOf("forcefield", "e2e-gates-on-pr", files)).toBe("gap");
  });
});
