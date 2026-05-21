/**
 * Schema contract guard: every workspace_id column across all
 * migrations MUST be the same type as the source-of-truth
 * (instinct_team_members.workspace_id, which is TEXT).
 *
 * Bug shipped on 2026-05-21: 4 tables (151/153/154/155) declared
 * workspace_id UUID NOT NULL while team_members holds the literal
 * string "default". Every GET on those tables 500'd with "invalid
 * input syntax for type uuid". Migration 156 fixed prod via ALTER;
 * this test stops the same mistake from re-shipping.
 *
 * Runs offline against the migration SQL files — no DB needed.
 */

import * as fs from "node:fs";
import * as path from "node:path";

const MIGRATIONS_DIR = path.resolve(__dirname, "../migrations");

interface WorkspaceIdDecl {
  migration: string;
  table: string;
  type: string;
}

function parseWorkspaceIdDecls(): WorkspaceIdDecl[] {
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql") && !f.endsWith(".down.sql")).sort();
  const out: WorkspaceIdDecl[] = [];
  for (const f of files) {
    const body = fs.readFileSync(path.join(MIGRATIONS_DIR, f), "utf8");
    /* Find CREATE TABLE blocks and the workspace_id line within each. */
    const createBlocks = [...body.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s*\(([\s\S]*?)\n\s*\);/gi)];
    for (const m of createBlocks) {
      const tableName = m[1];
      const block = m[2];
      const wsLine = block.split("\n").find((l) => /^\s*workspace_id\s+/i.test(l));
      if (!wsLine) continue;
      const typeMatch = wsLine.match(/^\s*workspace_id\s+([A-Z][A-Z0-9_]*)/i);
      if (!typeMatch) continue;
      out.push({ migration: f, table: tableName, type: typeMatch[1].toUpperCase() });
    }
    /* Also catch ALTER COLUMN ... TYPE ... statements (migration 156). */
    const alters = [...body.matchAll(/ALTER\s+TABLE\s+(\w+)\s+ALTER\s+COLUMN\s+workspace_id\s+TYPE\s+([A-Z][A-Z0-9_]*)/gi)];
    for (const a of alters) {
      out.push({ migration: f, table: a[1], type: a[2].toUpperCase() });
    }
  }
  return out;
}

describe("schema contract: workspace_id type consistency", () => {
  it("every workspace_id column EVENTUALLY resolves to TEXT", () => {
    const decls = parseWorkspaceIdDecls();
    /* Compute the LATEST declared type per table (most recent
       migration wins — handles ALTER TYPE later in the timeline). */
    const finalType = new Map<string, { migration: string; type: string }>();
    for (const d of decls) {
      finalType.set(d.table, { migration: d.migration, type: d.type });
    }
    const wrong: string[] = [];
    for (const [table, info] of finalType.entries()) {
      if (info.type !== "TEXT") {
        wrong.push(`${table} (last set to ${info.type} in ${info.migration})`);
      }
    }
    expect(wrong).toEqual([]);
  });
});
