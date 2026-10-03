/**
 * The catalog's collectSignals + criteria, graded against a FAKE repo reader so
 * the test is hermetic (no filesystem). Proves the static checks read the facts
 * they claim, and that a clean repo flips the criteria to ready - i.e. the engine
 * is a real, movable measure, not a hardcoded score.
 */
import { READINESS_TOOLS, toolById } from "@/lib/readiness/catalog";
import { reportTool } from "@/lib/readiness/report";
import type { RepoReader } from "@/lib/readiness/types";

/** A fake repo: a map of path -> contents, plus a list of files per dir. */
function fakeReader(files: Record<string, string>): RepoReader {
  const paths = Object.keys(files);
  return {
    read: (p) => (p in files ? files[p] : null),
    exists: (p) => p in files || paths.some((x) => x.startsWith(p + "/")),
    listFiles: (dir, suffix) =>
      paths.filter((p) => (p === dir || p.startsWith(dir + "/")) && (!suffix || p.endsWith(suffix))),
  };
}

describe("catalog shape", () => {
  it("every criterion has a unique id within its tool", () => {
    for (const t of READINESS_TOOLS) {
      const ids = t.criteria.map((c) => c.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
  it("toolById resolves known tools and misses unknown", () => {
    expect(toolById("ai-code")?.label).toBe("Code Factory");
    expect(toolById("nope")).toBeUndefined();
  });
});

describe("ai-code signals + grading", () => {
  const WORKED_UP = {
    // E2E wired into a pull_request workflow, no test.skip
    ".github/workflows/factory-live-dogfood.yml":
      "on:\n  pull_request:\n    branches: [main]\n  schedule: []\njobs:\n  dogfood:\n    steps:\n      - run: npx playwright test tests/e2e/ai-code-factory-live.spec.ts",
    "tests/e2e/ai-code-factory-live.spec.ts": "test('live', async () => {});",
    "src/app/api/admin/ai-code/pipeline/route.ts": "trackEvent({});\nconst ws = x.workspaceId;",
    "src/lib/ai-code/deep-scan.ts": "export function deepScan(changedLines) { return addedLines; }",
    "src/lib/ai-code/x.db.test.ts": "db",
    "src/app/api/admin/ai-code/y.db.test.ts": "db",
    "src/db/migrations/212_ai_code_reviews.sql":
      "CREATE TABLE instinct_ai_code_reviews(workspace_id uuid);\nENABLE ROW LEVEL SECURITY;\nCREATE POLICY p ON instinct_ai_code_reviews USING (workspace_id = current_setting('app.workspace')::uuid);",
  };

  it("a worked-up repo flips the auto criteria to ready (the engine is movable)", () => {
    const r = reportTool(toolById("ai-code")!, fakeReader(WORKED_UP));
    const by = Object.fromEntries(r.results.map((x) => [x.id, x.status]));
    expect(by["db-tests"]).toBe("ready"); // 2 db tests
    expect(by["e2e-gates-on-pr"]).toBe("ready"); // PR-gated, no skip
    expect(by["isolation-db-enforced"]).toBe("ready"); // real RLS, no USING(true)
    expect(by["no-default-workspace-coalesce"]).toBe("ready"); // no ?? "default"
    expect(by["deep-scan-covers-edits"]).toBe("ready"); // reads changed/added lines
  });

  it("the current repo reality registers the known gaps", () => {
    const CURRENT = {
      "tests/e2e/ai-code-factory-live.spec.ts": "test.skip(!x); test('live', () => {});",
      "src/app/api/admin/ai-code/pipeline/route.ts": 'const ws = x.workspaceId ?? "default";',
      "src/lib/ai-code/deep-scan.ts": "newFilesFromDiff(diff)",
      "src/db/migrations/212_ai_code_reviews.sql":
        "CREATE TABLE instinct_ai_code_reviews(id uuid);\nENABLE ROW LEVEL SECURITY;\nCREATE POLICY p ON instinct_ai_code_reviews FOR ALL USING (true) WITH CHECK (true);",
    };
    const r = reportTool(toolById("ai-code")!, fakeReader(CURRENT));
    const by = Object.fromEntries(r.results.map((x) => [x.id, x.status]));
    expect(by["db-tests"]).toBe("gap"); // none
    expect(by["e2e-gates-on-pr"]).toBe("gap"); // not in a PR workflow (no workflow file here)
    expect(by["isolation-db-enforced"]).toBe("gap"); // USING(true) tripwire
    expect(by["no-default-workspace-coalesce"]).toBe("gap"); // ?? "default" present
    expect(by["deep-scan-covers-edits"]).toBe("gap"); // new-files-only
    expect(by["no-silent-model-degrade"]).toBe("gap"); // attested
  });
});

describe("site-analytics signals + grading", () => {
  it("flags the events-table isolation + perf + promote-surface gaps", () => {
    const CURRENT = {
      "src/db/migrations/178_site_analytics_events.sql":
        "CREATE TABLE site_analytics_events(id bigserial, created_at timestamptz, event_type text, props jsonb);\nCREATE INDEX ON site_analytics_events(created_at);",
      "src/app/api/site-analytics/operator/promote/route.ts": 'const SURFACE = "ogiam.com";',
      "src/lib/site-analytics.ts": "function collectsPageViews(){} // hostileOperators",
      "src/app/api/admin/site-analytics/route.ts": "recordAudit(); trackEvent();",
    };
    const r = reportTool(toolById("site-analytics")!, fakeReader(CURRENT));
    const by = Object.fromEntries(r.results.map((x) => [x.id, x.status]));
    expect(by["isolation-db-enforced"]).toBe("gap"); // no workspace_id on events table
    expect(by["events-perf-indexes"]).toBe("gap"); // no site/fp index
    expect(by["promote-surface-correct"]).toBe("gap"); // hardcoded host
    expect(by["truthfulness"]).toBe("ready"); // the honest metrics are present
    expect(by["observability"]).toBe("ready"); // analytics + audit in routes
  });
});
