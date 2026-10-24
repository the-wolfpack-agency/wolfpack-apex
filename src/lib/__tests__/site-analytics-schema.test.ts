/**
 * Schema guard for every query the Forcefield board runs.
 *
 * WHY: the board's reads go through safeQuery, which swallows a SQL error and
 * returns no rows. A query that names a column the table does not have therefore
 * never fails: it just reads as an honest-looking zero forever. That is exactly
 * how the analyst false-positive counter read 0 for its whole life (it filtered
 * instinct_events on created_at; the column is `timestamp`).
 *
 * HOW: run the real board readers with the DB mocked to capture every SQL
 * string, build the table -> columns map from the migrations themselves, and
 * assert every bare identifier in each query is a column of the table(s) it
 * reads (or a SQL keyword / function / alias). No database needed, so it runs in
 * every jest pass; the migrations are the schema of record.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const calls: Array<[string, unknown[]]> = [];
jest.mock("@/lib/db", () => ({
  query: jest.fn(async () => ({ rows: [] })),
  safeQuery: jest.fn(async (sql: string, params: unknown[]) => {
    calls.push([String(sql), params ?? []]);
    return { rows: [] };
  }),
}));

import { getSiteAnalyticsSummary, countVerdictFalsePositives } from "@/lib/site-analytics";
import { liveAgentIntelligence, liveOperatorDossiers, listSightings, listBlockedOperatorKeys } from "@/lib/agent-operators";
import { liveWebProtectionDeps } from "@/lib/forcefield-web/rollup";

const MIGRATIONS = join(__dirname, "..", "..", "db", "migrations");

/** table -> columns, from CREATE TABLE bodies + ALTER TABLE ... ADD COLUMN. */
function schemaFromMigrations(): Map<string, Set<string>> {
  const tables = new Map<string, Set<string>>();
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql") && !f.endsWith(".down.sql")).sort();
  for (const f of files) {
    const sql = readFileSync(join(MIGRATIONS, f), "utf8").replace(/--[^\n]*/g, "");
    const create = /CREATE TABLE(?: IF NOT EXISTS)?\s+([a-z_][a-z0-9_]*)\s*\(/gi;
    let m: RegExpExecArray | null;
    while ((m = create.exec(sql))) {
      // Walk to the matching close paren of the column list.
      let depth = 1;
      let i = create.lastIndex;
      for (; i < sql.length && depth > 0; i++) {
        if (sql[i] === "(") depth++;
        else if (sql[i] === ")") depth--;
      }
      const body = sql.slice(create.lastIndex, i - 1);
      const cols = tables.get(m[1].toLowerCase()) ?? new Set<string>();
      // Top-level comma split (ignore commas inside nested parens).
      let d = 0;
      let cur = "";
      const parts: string[] = [];
      for (const ch of body) {
        if (ch === "(") d++;
        if (ch === ")") d--;
        if (ch === "," && d === 0) { parts.push(cur); cur = ""; } else cur += ch;
      }
      parts.push(cur);
      for (const p of parts) {
        const first = p.trim().split(/\s+/)[0]?.replace(/"/g, "").toLowerCase();
        if (!first || /^(primary|unique|constraint|foreign|check|exclude)$/.test(first)) continue;
        cols.add(first);
      }
      tables.set(m[1].toLowerCase(), cols);
    }
    const alter = /ALTER TABLE(?: IF EXISTS)?\s+([a-z_][a-z0-9_]*)\s+([^;]*);/gi;
    while ((m = alter.exec(sql))) {
      const add = /ADD COLUMN(?: IF NOT EXISTS)?\s+([a-z_][a-z0-9_]*)/gi;
      let a: RegExpExecArray | null;
      const cols = tables.get(m[1].toLowerCase()) ?? new Set<string>();
      while ((a = add.exec(m[2]))) cols.add(a[1].toLowerCase());
      tables.set(m[1].toLowerCase(), cols);
    }
  }
  // The apex_* -> instinct_* rename (migrations 036-076) runs inside DO blocks,
  // so it is applied here by rule rather than parsed.
  for (const [name, cols] of Array.from(tables)) {
    if (name.startsWith("apex_")) {
      const renamed = `instinct_${name.slice(5)}`;
      const existing = tables.get(renamed) ?? new Set<string>();
      cols.forEach((c) => existing.add(c));
      tables.set(renamed, existing);
    }
  }
  return tables;
}

const KEYWORDS = new Set(
  (
    "select from where and or not in is null as count filter distinct group by order desc asc limit offset coalesce extract hour " +
    "at time zone now interval like ilike exists case when then else end max min sum avg row_number over partition any all text int " +
    "integer numeric boolean bigint true false on union with having between join left right inner outer cross lateral using values " +
    "insert into update set delete returning conflict do nothing jsonb json array cast date day days string_agg array_agg lower upper"
  ).split(" "),
);

/** Bare identifiers in a query: string literals, casts, params, and declared
 *  aliases removed. What remains must be columns. */
function bareIdentifiers(sql: string): { idents: Set<string>; tables: string[] } {
  const noStrings = sql.replace(/'(?:[^']|'')*'/g, "''");
  const aliases = new Set<string>();
  for (const m of noStrings.matchAll(/\bAS\s+([a-z_][a-z0-9_]*)/gi)) aliases.add(m[1].toLowerCase());
  for (const m of noStrings.matchAll(/\)\s+([a-z_][a-z0-9_]*)/gi)) aliases.add(m[1].toLowerCase());
  const tables = Array.from(noStrings.matchAll(/\bFROM\s+([a-z_][a-z0-9_]*)/gi)).map((m) => m[1].toLowerCase());
  const stripped = noStrings.replace(/::[a-z_]+(\[\])?/gi, " ").replace(/\$\d+/g, " ");
  const idents = new Set<string>();
  for (const m of stripped.matchAll(/\b([a-z_][a-z0-9_]*)\b/gi)) {
    const w = m[1].toLowerCase();
    if (KEYWORDS.has(w) || aliases.has(w)) continue;
    idents.add(w);
  }
  return { idents, tables };
}

beforeAll(async () => {
  process.env.DATABASE_URL = "postgres://schema-guard";
  await getSiteAnalyticsSummary(30, "ws-1", "all");
  await getSiteAnalyticsSummary(30, "ws-1", "instinct");
  await countVerdictFalsePositives("ws-1", 30);
  await liveAgentIntelligence(30);
  await liveOperatorDossiers(30);
  await listSightings("ws-1", 30);
  await listBlockedOperatorKeys("ws-1");
  await liveWebProtectionDeps().listInspections("default", 10);
  await liveWebProtectionDeps().listInspections("instinct", 10);
});

describe("board queries match the migrated schema", () => {
  const schema = schemaFromMigrations();

  it("the parser sees the tables the board reads (sanity)", () => {
    expect(schema.get("instinct_events")).toEqual(expect.objectContaining({}));
    expect(schema.get("instinct_events")!.has("timestamp")).toBe(true);
    expect(schema.get("instinct_events")!.has("created_at")).toBe(false);
    expect(schema.get("site_analytics_events")!.has("created_at")).toBe(true);
    expect(schema.get("site_analytics_events")!.has("forcefield_tenant_id")).toBe(true);
  });

  it("captured the board's queries", () => {
    expect(calls.length).toBeGreaterThan(20);
    expect(calls.some(([sql]) => sql.includes("FROM instinct_events"))).toBe(true);
  });

  it("every identifier in every single-table query is a real column of that table", () => {
    const problems: string[] = [];
    let checked = 0;
    for (const [sql] of calls) {
      if (/\bJOIN\b/i.test(sql)) continue; // multi-table queries are out of this guard's scope
      const { idents, tables } = bareIdentifiers(sql);
      const known = tables.filter((t) => schema.has(t));
      if (known.length === 0) continue;
      checked++;
      const cols = new Set<string>();
      for (const t of known) schema.get(t)!.forEach((c) => cols.add(c));
      for (const t of tables) if (!schema.has(t) && !cols.has(t)) problems.push(`unknown table "${t}" in: ${sql.slice(0, 120)}`);
      for (const id of Array.from(idents)) {
        if (cols.has(id) || schema.has(id)) continue;
        problems.push(`"${id}" is not a column of ${known.join("+")}: ${sql.replace(/\s+/g, " ").slice(0, 160)}`);
      }
    }
    expect(checked).toBeGreaterThan(15);
    expect(problems).toEqual([]);
  });

  it("would have caught the original false-positive bug", () => {
    const old = `SELECT count(*)::text AS n FROM instinct_events WHERE event_type = 'x' AND metadata->>'workspace_id' = $1 AND created_at > NOW() - ($2::int * INTERVAL '1 day')`;
    const { idents } = bareIdentifiers(old);
    const cols = schema.get("instinct_events")!;
    expect(Array.from(idents).filter((i) => !cols.has(i) && !schema.has(i))).toEqual(["created_at"]);
  });
});
