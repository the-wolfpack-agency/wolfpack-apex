/**
 * tenant-isolation-global.test.ts
 *
 * REPO-WIDE GUARDRAIL: the single worst failure class for a multi-tenant
 * product is a query that reads/writes a workspace-scoped table WITHOUT a
 * `workspace_id` predicate — a silent cross-tenant data leak. The platform-scan
 * suite (src/lib/platform-scan/__tests__/tenant-isolation.test.ts) already
 * guards its 7 tables; this test generalises the SAME heuristics to EVERY
 * workspace-scoped table across ALL of src/, so a forgotten predicate anywhere
 * fails the build.
 *
 * The scanner (src/lib/db/tenant-scope-scan.ts) classifies every offender into a
 * named benign class — principal-resolve, pk-pinned-upstream,
 * resolves-from-credential, system-cross-workspace, dynamic-where,
 * not-a-table-access — or "unclassified". An unclassified offender is a query
 * filtering a tenant-owned table by a non-tenant business key (exactly the
 * job-codes-dossier bug this work fixed). The hard gate: unclassified === 0.
 *
 * No DB: reads sources via fs.
 */
import fs from "fs";
import path from "path";
import {
  scanRepo,
  classifyFilter,
  discoverScopedTables,
  PRINCIPAL_TABLES,
} from "../tenant-scope-scan";

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const result = scanRepo(REPO_ROOT);

describe("repo-wide tenant isolation guardrail", () => {
  it("finds the workspace-scoped tables (discovery did not silently break)", () => {
    // If migrations move or the parser regresses this drops to ~0 and the whole
    // guardrail goes vacuously green. Pin a floor well below the real count (37).
    expect(result.scopedTables.length).toBeGreaterThanOrEqual(30);
  });

  it("every principal/identity table is itself workspace-scoped", () => {
    for (const t of PRINCIPAL_TABLES) {
      expect(result.scopedTables).toContain(t);
    }
  });

  it("has ZERO unclassified cross-tenant offenders", () => {
    // THE GATE. A failure prints each leaking query verbatim. To fix: add
    // `AND workspace_id = $n` to the query. Only if the omission is genuinely a
    // documented benign class (see tenant-scope-scan.ts) does the classifier
    // already cover it — a NEW class needs a deliberate rule there, with reason.
    const report = result.unclassified
      .map((o) => `CROSS-TENANT LEAK: ${o.file} [${o.table}] ${o.kind}\n    ${o.snippet}`)
      .join("\n");
    expect(report).toBe("");
    expect(result.unclassified).toEqual([]);
  });

  it("the classifier is not vacuous — a synthetic business-key leak is caught", () => {
    // Prove the gate has teeth: a SELECT on a real scoped table filtered only by
    // a non-tenant business key (the exact shape of the dossier bug) classifies
    // as "unclassified".
    const leak = `SELECT id, amount FROM instinct_invoices WHERE invoice_number = $1 LIMIT 1`;
    expect(classifyFilter("src/lib/finance/leak.ts", leak, "instinct_invoices")).toBe("unclassified");

    // And the correct form is NOT flagged by the classifier's benign rules:
    // a pk-pinned update is a recognised, sound exception, not unclassified.
    const pkPinned = `UPDATE instinct_invoices SET status = $2 WHERE id = $1`;
    expect(classifyFilter("src/lib/finance/ok.ts", pkPinned, "instinct_invoices")).toBe("pk-pinned-upstream");
  });

  it("the job-codes dossier (the leak this work fixed) is scoped to a workspace", () => {
    // Regression anchor: both tenant-owned sources in the dossier carry a
    // workspace_id predicate. (The cache + analytics events have no workspace_id
    // column and are global by design.)
    const src = fs.readFileSync(path.join(REPO_ROOT, "src/lib/job-codes/dossier.ts"), "utf8");
    const receipts = src.slice(src.indexOf("instinct_receipt_scans"));
    const edits = src.slice(src.indexOf("instinct_job_codes_edits"));
    expect(receipts).toMatch(/workspace_id\s*=\s*\$2/);
    expect(edits).toMatch(/workspace_id\s*=\s*\$2/);
  });
});

describe("tenant-isolation committed baseline stays in sync", () => {
  const BASELINE = path.join(REPO_ROOT, "src/lib/db/__generated__/tenant-isolation-baseline.json");

  it("exists and records zero unclassified offenders", () => {
    expect(fs.existsSync(BASELINE)).toBe(true);
    const b = JSON.parse(fs.readFileSync(BASELINE, "utf8"));
    expect(b.unclassifiedCount).toBe(0);
  });

  it("its scoped-table set matches the live scan (regenerate with the script when this trips)", () => {
    // Deep-equality on the scoped-table set forces `npm run scan:tenant-isolation
    // -- --write` whenever a workspace-scoped table is added/removed — the exact
    // moment a human should re-review tenancy.
    const b = JSON.parse(fs.readFileSync(BASELINE, "utf8"));
    expect(b.scopedTables).toEqual(result.scopedTables);
  });

  it("its FORCE-RLS enforced-table set matches the live scan (retrofit progress is tracked)", () => {
    // Every table that graduates to real FORCE-RLS must regenerate the baseline,
    // so the recorded coverage metric (and the whitepaper-caveat status) stays true.
    const b = JSON.parse(fs.readFileSync(BASELINE, "utf8"));
    expect(b.enforcedTables ?? []).toEqual(result.enforcedTables);
    // Enforced tables must themselves be workspace-scoped.
    for (const t of result.enforcedTables) expect(result.scopedTables).toContain(t);
  });
});

describe("discoverScopedTables", () => {
  it("returns the same set scanRepo used (pure, deterministic)", () => {
    expect([...discoverScopedTables(REPO_ROOT)].sort()).toEqual(result.scopedTables);
  });
});
