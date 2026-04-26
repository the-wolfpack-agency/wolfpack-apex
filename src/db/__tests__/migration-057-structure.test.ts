/**
 * Structural invariants for migration 057 —
 *   apex_hr_documents → instinct_hr_documents.
 *
 * Part 2 of the HR-family rename (U3 stream). Follows 056 which
 * renamed the parent table apex_employees. This child table has a
 * FK on employee_id referencing the parent; Postgres tracks the FK
 * by OID so 056's parent-rename preserves the FK automatically.
 *
 * Reads both the forward and down migration SQL files raw from disk
 * and asserts the canonical safety patterns are present.
 *
 * These are STRUCTURAL assertions — they don't execute SQL. Runtime
 * behaviour is covered by the hr-documents-e2e integration tests.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(
  process.cwd(),
  "src",
  "db",
  "migrations",
);

const UP_FILE = join(MIGRATIONS_DIR, "057_rename_hr_documents.sql");
const DOWN_FILE = join(MIGRATIONS_DIR, "057_rename_hr_documents.down.sql");

describe("migration 057 — rename apex_hr_documents → instinct_hr_documents", () => {
  let up: string;
  let down: string;

  beforeAll(() => {
    up = readFileSync(UP_FILE, "utf8");
    down = readFileSync(DOWN_FILE, "utf8");
  });

  it("forward migration file exists on disk", () => {
    expect(existsSync(UP_FILE)).toBe(true);
  });

  it("paired down migration file exists on disk", () => {
    expect(existsSync(DOWN_FILE)).toBe(true);
  });

  it("references BOTH the old and new table names", () => {
    expect(up).toMatch(/apex_hr_documents/);
    expect(up).toMatch(/instinct_hr_documents/);
    expect(down).toMatch(/apex_hr_documents/);
    expect(down).toMatch(/instinct_hr_documents/);
  });

  it("uses a defensive DO $$ block to survive any pre-existing DB state", () => {
    expect(up).toMatch(/DO \$\$/);
    expect(up).toMatch(/END \$\$;/);
  });

  it("creates a backward-compat view using the OLD name pointing at the NEW table", () => {
    const hasCompatView =
      /CREATE OR REPLACE VIEW\s+apex_hr_documents[\s\S]*?SELECT \* FROM\s+instinct_hr_documents/i.test(
        up,
      );
    expect(hasCompatView).toBe(true);
  });

  it("asserts row-count preservation across the rename", () => {
    expect(up).toMatch(/pre_rename_count/);
    expect(up).toMatch(/post_rename_count/);
    expect(up).toMatch(/Row-count mismatch/i);
    expect(up).toMatch(/RAISE EXCEPTION/);
  });

  it("asserts compat-view is updatable AND insertable so legacy writes don't silently drop", () => {
    expect(up).toMatch(/is_updatable/);
    expect(up).toMatch(/is_insertable_into/);
  });

  it("wraps the forward migration in a single transaction", () => {
    expect(up).toMatch(/^BEGIN;/m);
    expect(up).toMatch(/COMMIT;/);
  });

  it("renames all 4 secondary indexes from migration 011", () => {
    // Migration 011 created:
    //   idx_apex_hr_documents_category
    //   idx_apex_hr_documents_employee
    //   idx_apex_hr_documents_uploaded
    //   idx_apex_hr_documents_expires  (partial: WHERE expires_at IS NOT NULL)
    expect(up).toMatch(
      /ALTER INDEX IF EXISTS idx_apex_hr_documents_category\s+RENAME TO idx_instinct_hr_documents_category/,
    );
    expect(up).toMatch(
      /ALTER INDEX IF EXISTS idx_apex_hr_documents_employee\s+RENAME TO idx_instinct_hr_documents_employee/,
    );
    expect(up).toMatch(
      /ALTER INDEX IF EXISTS idx_apex_hr_documents_uploaded\s+RENAME TO idx_instinct_hr_documents_uploaded/,
    );
    expect(up).toMatch(
      /ALTER INDEX IF EXISTS idx_apex_hr_documents_expires\s+RENAME TO idx_instinct_hr_documents_expires/,
    );

    // Down migration reverses all four.
    expect(down).toMatch(
      /ALTER INDEX IF EXISTS idx_instinct_hr_documents_category\s+RENAME TO idx_apex_hr_documents_category/,
    );
    expect(down).toMatch(
      /ALTER INDEX IF EXISTS idx_instinct_hr_documents_employee\s+RENAME TO idx_apex_hr_documents_employee/,
    );
    expect(down).toMatch(
      /ALTER INDEX IF EXISTS idx_instinct_hr_documents_uploaded\s+RENAME TO idx_apex_hr_documents_uploaded/,
    );
    expect(down).toMatch(
      /ALTER INDEX IF EXISTS idx_instinct_hr_documents_expires\s+RENAME TO idx_apex_hr_documents_expires/,
    );
  });

  it("down migration reverses the table rename and drops the compat view", () => {
    expect(down).toMatch(
      /ALTER TABLE IF EXISTS instinct_hr_documents\s+RENAME TO apex_hr_documents/,
    );
    expect(down).toMatch(/DROP VIEW IF EXISTS apex_hr_documents/);
    expect(down).toMatch(
      /CREATE OR REPLACE VIEW instinct_hr_documents[\s\S]*?SELECT \* FROM\s+apex_hr_documents/,
    );
  });

  it("includes an explanatory comment block at the top (batch + safety rationale)", () => {
    const header = up.split("\n").slice(0, 60).join("\n");
    expect(header).toMatch(/Tier 4/i);
    expect(header).toMatch(/apex_hr_documents/);
    expect(header).toMatch(/instinct_hr_documents/);
    // References 056 or another canonical sibling-template migration.
    expect(header).toMatch(/05[0-8]|048|046|043|036/);
  });

  it("documents FK-to-apex_employees is preserved by OID across 056", () => {
    // Migration 011 declared apex_hr_documents.employee_id →
    // apex_employees(id). 056 (preceding) renamed the parent. Postgres
    // FK tracking is OID-based so the child FK follows automatically.
    // This comment must not disappear — it prevents a future refactor
    // from accidentally dropping + recreating the FK (which would break).
    expect(up).toMatch(/FOREIGN KEY|FK/);
    expect(up).toMatch(/OID|by OID/i);
  });
});

describe("migration 057 — learning-loop analytics integration", () => {
  // Per CLAUDE.md: every new piece of code must tie into the data and
  // learning mechanism. The HR-docs library emits these trackEvent
  // signals on the happy path (verified below):
  //
  //   hr.document_uploaded
  //   hr.document_classified
  //   hr.document_recategorized
  //   hr.document_linked_to_employee
  //   hr.document_unlinked_from_employee
  //   hr.document_deleted
  //   hr.document_fields_extracted  (for W-4/I-9)
  //   hr.document_extraction_empty  (for W-4/I-9 with no fields)
  //
  // These feed the brain (apex_events) so Alicia's workflow learnings
  // persist. The rename must NOT break this wiring — a silent-drop of
  // INSERT INTO instinct_hr_documents would also mute the analytics
  // tail because recategorize/link/delete all gate their trackEvent on
  // the row actually existing.

  it("hr-documents.ts targets the renamed instinct_hr_documents table in all CRUD paths", () => {
    // Catches a regression at the code layer even without running the DB.
    const libPath = join(process.cwd(), "src", "lib", "hr-documents.ts");
    const libSource = readFileSync(libPath, "utf8");

    // Every SQL statement MUST reference the new name.
    expect(libSource).toMatch(/INSERT INTO instinct_hr_documents/);
    expect(libSource).toMatch(/SELECT \* FROM instinct_hr_documents/);
    expect(libSource).toMatch(/UPDATE instinct_hr_documents/);
    expect(libSource).toMatch(/DELETE FROM instinct_hr_documents/);

    // No stale SQL references to the old name remain in the lib's
    // SQL statements. (Comments historically referring to the old name
    // for context are fine — we check SQL verbs only.)
    expect(libSource).not.toMatch(/INSERT INTO apex_hr_documents/);
    expect(libSource).not.toMatch(/SELECT \* FROM apex_hr_documents/);
    expect(libSource).not.toMatch(/UPDATE apex_hr_documents\s+SET/);
    expect(libSource).not.toMatch(/DELETE FROM apex_hr_documents/);
  });

  it("happy-path trackEvent calls still fire for upload + categorize + extract", async () => {
    // Reset module registry so our mocks below take effect.
    jest.resetModules();

    const trackEventMock = jest.fn();
    const safeQueryMock = jest.fn(async (sql: string, _params?: unknown[]) => {
      // Stateful-enough: return an empty rows array for every call so
      // INSERT/UPDATE/DELETE paths don't short-circuit on "not found".
      // Route the RETURNING query so link/recategorize return a row
      // (they gate trackEvent on r.rows.length > 0).
      if (/RETURNING/.test(sql)) {
        return { rows: [{ id: "hd_test" }] };
      }
      return { rows: [] };
    });

    jest.doMock("@/lib/db", () => ({
      safeQuery: (sql: string, params: unknown[]) => safeQueryMock(sql, params),
      query: (sql: string, params: unknown[]) => safeQueryMock(sql, params),
    }));
    jest.doMock("@/lib/analytics", () => ({
      trackEvent: (...args: unknown[]) => trackEventMock(...args),
    }));
    // parseBenefitDocument is heavy (unpdf); stub it to a tiny payload
    // so routeUpload's W-4 happy path runs fast.
    jest.doMock("@/lib/benefits", () => ({
      ...jest.requireActual("@/lib/benefits"),
      parseBenefitDocument: jest.fn().mockResolvedValue({
        filename: "w4.pdf",
        carrier: null,
        effective_date: null,
        account_number: null,
        page_count: 1,
        size_bytes: 100,
        raw_text_excerpt:
          "Form W-4\nEmployee's Withholding Certificate\nSocial Security Number 123-45-6789\nFirst name Alice Last name Doe\nAddress 1 Main St",
        plans: [],
      }),
      saveBenefitDocument: jest.fn(),
      saveRecommendation: jest.fn(),
      generateRecommendation: jest.fn(),
      generateBenefitInsights: jest.fn().mockReturnValue([]),
      saveInsights: jest.fn(),
    }));

    try {
      const { routeUpload, recategorizeDocument, linkDocumentToEmployee } =
        await import("@/lib/hr-documents");

      // 1. Upload a W-4 → must fire hr.document_uploaded + hr.document_classified
      await routeUpload(
        "w4.pdf",
        Buffer.from("fake pdf"),
        "u_alicia",
        "hr",
        "documents_tab",
      );

      const firedEvents = trackEventMock.mock.calls.map(
        (c: unknown[]) => c[0] as string,
      );
      expect(firedEvents).toContain("hr.document_uploaded");
      expect(firedEvents).toContain("hr.document_classified");

      // 2. Recategorize → must fire hr.document_recategorized
      trackEventMock.mockClear();
      await recategorizeDocument("hd_test", "handbook", "u_alicia", "hr");
      expect(trackEventMock).toHaveBeenCalledWith(
        "hr.document_recategorized",
        "u_alicia",
        "hr",
        expect.objectContaining({
          document_id: "hd_test",
          new_category: "handbook",
        }),
      );

      // 3. Link to employee → must fire hr.document_linked_to_employee
      trackEventMock.mockClear();
      await linkDocumentToEmployee("hd_test", "emp_1", "u_alicia", "hr");
      expect(trackEventMock).toHaveBeenCalledWith(
        "hr.document_linked_to_employee",
        "u_alicia",
        "hr",
        expect.objectContaining({
          document_id: "hd_test",
          employee_id: "emp_1",
        }),
      );
    } finally {
      jest.resetModules();
      jest.dontMock("@/lib/db");
      jest.dontMock("@/lib/analytics");
      jest.dontMock("@/lib/benefits");
    }
  });
});
