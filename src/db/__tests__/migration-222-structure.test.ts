/**
 * Structural invariants for migration 222_task_outlook_fields.
 *
 * Runs against the raw SQL text only (no live DB). Asserts the migration
 * additively adds the Outlook To Do fields (reminder_at, is_reminder_on,
 * start_at, categories) idempotently, guards the reminder index, and ships
 * a paired idempotent down migration. Assignment must NOT be added here —
 * To Do has no assignments in Graph (that lives in Planner).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(__dirname, "..", "migrations");
const upSql = readFileSync(join(MIGRATIONS_DIR, "222_task_outlook_fields.sql"), "utf8");
const downSql = readFileSync(join(MIGRATIONS_DIR, "222_task_outlook_fields.down.sql"), "utf8");

const TABLE = "instinct_tasks";

describe("migration 222 — To Do Outlook fields", () => {
  it("wraps the body in BEGIN/COMMIT", () => {
    expect(upSql.trim()).toMatch(/BEGIN;[\s\S]+COMMIT;\s*$/);
    expect(downSql.trim()).toMatch(/BEGIN;[\s\S]+COMMIT;\s*$/);
  });

  it("adds reminder_at / start_at as nullable TIMESTAMPTZ, idempotently", () => {
    expect(upSql).toMatch(
      new RegExp(`ALTER\\s+TABLE\\s+${TABLE}\\s+ADD\\s+COLUMN\\s+IF\\s+NOT\\s+EXISTS\\s+reminder_at\\s+TIMESTAMPTZ`),
    );
    expect(upSql).toMatch(
      new RegExp(`ALTER\\s+TABLE\\s+${TABLE}\\s+ADD\\s+COLUMN\\s+IF\\s+NOT\\s+EXISTS\\s+start_at\\s+TIMESTAMPTZ`),
    );
  });

  it("adds is_reminder_on BOOLEAN defaulting to false", () => {
    expect(upSql).toMatch(/ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+is_reminder_on\s+BOOLEAN\s+NOT\s+NULL\s+DEFAULT\s+false/);
  });

  it("adds categories as a JSONB array defaulting to []", () => {
    expect(upSql).toMatch(/ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+categories\s+JSONB\s+NOT\s+NULL\s+DEFAULT\s+'\[\]'::jsonb/);
  });

  it("guards the reminder index with IF NOT EXISTS and a partial WHERE", () => {
    expect(upSql).toMatch(
      new RegExp(`CREATE\\s+INDEX\\s+IF\\s+NOT\\s+EXISTS\\s+idx_instinct_tasks_user_reminder[\\s\\S]*?ON\\s+${TABLE}`),
    );
    expect(upSql).toMatch(/WHERE\s+is_reminder_on\s*=\s*true/);
  });

  it("does NOT add an assignment column (To Do has no assignments in Graph)", () => {
    expect(upSql).not.toMatch(/ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+\w*assign/i);
  });

  it("down migration drops every added column + index idempotently", () => {
    expect(downSql).toMatch(/DROP\s+INDEX\s+IF\s+EXISTS\s+idx_instinct_tasks_user_reminder/);
    for (const col of ["reminder_at", "is_reminder_on", "start_at", "categories"]) {
      expect(downSql).toMatch(new RegExp(`DROP\\s+COLUMN\\s+IF\\s+EXISTS\\s+${col}`));
    }
  });
});
