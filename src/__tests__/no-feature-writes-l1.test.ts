/**
 * Enforces: NO feature code writes directly to L1 canonical MS Graph tables.
 *
 * L1 canonical tables (owned by src/lib/ms-graph/sync/**):
 *   instinct_ms_events, instinct_ms_tasks, instinct_ms_messages,
 *   instinct_ms_contacts, instinct_ms_files, instinct_ms_change_log,
 *   instinct_ms_sync_cursors
 *
 * Feature code that wants to attach context to an MS entity MUST go through
 * the L3 polymorphic layer:
 *   - src/lib/entity-tags.ts
 *   - src/lib/entity-links.ts
 *   - src/lib/ms-graph/auto-tag.ts
 *
 * Rationale: L1 is the single source of truth for Graph state, kept in
 * strict sync with Microsoft's delta cursors. If feature code mutates
 * those rows, we break the sync invariant (next delta will either wipe
 * the feature write or mark the row as conflicted). L3 tags/links keep
 * L1 pristine while letting features annotate freely.
 *
 * Allowed exceptions:
 *   - src/lib/ms-graph/sync/**           — the sync owner, by design
 *   - src/db/migrations/**               — schema DDL, not runtime writes
 *   - src/lib/__tests__/**, src/__tests__/** — test fixtures / this file
 */
import fs from "fs";
import path from "path";

const L1_TABLES = [
  "instinct_ms_events",
  "instinct_ms_tasks",
  "instinct_ms_messages",
  "instinct_ms_contacts",
  "instinct_ms_files",
  "instinct_ms_change_log",
  "instinct_ms_sync_cursors",
];

// Folders / files where writes to L1 are allowed.
const WRITE_EXCEPTIONS = [
  "src/lib/ms-graph/sync/",
  "src/db/migrations/",
  "src/lib/__tests__/",
  "src/__tests__/",
  "node_modules/",
  ".next/",
];

const WALK_SKIP = ["node_modules", ".next", ".git", "dist", "build"];

function walk(dir: string): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (WALK_SKIP.includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx|js|jsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

function isExempt(relPath: string): boolean {
  const norm = relPath.split(path.sep).join("/");
  return WRITE_EXCEPTIONS.some((e) => norm.includes(e));
}

/**
 * Scan a single file for L1 write statements. Returns offenders with the
 * exact offending line so failure output is actionable.
 */
function scanFile(
  file: string,
  rootRel: string,
): Array<{ file: string; line: number; statement: string; table: string }> {
  const src = fs.readFileSync(file, "utf8");
  const lines = src.split("\n");
  const offenders: Array<{ file: string; line: number; statement: string; table: string }> = [];

  for (const table of L1_TABLES) {
    // Patterns: INSERT INTO <t>, UPDATE <t>, DELETE FROM <t>. Whitespace
    // flexible so multi-line writeQuery() template-literals still match
    // on the anchor line containing the table name.
    const patterns: Array<{ re: RegExp; kind: string }> = [
      { re: new RegExp(`\\bINSERT\\s+INTO\\s+${table}\\b`, "i"), kind: "INSERT" },
      { re: new RegExp(`\\bUPDATE\\s+${table}\\b`, "i"), kind: "UPDATE" },
      { re: new RegExp(`\\bDELETE\\s+FROM\\s+${table}\\b`, "i"), kind: "DELETE" },
    ];
    lines.forEach((line, i) => {
      for (const { re, kind } of patterns) {
        if (re.test(line)) {
          offenders.push({
            file: rootRel,
            line: i + 1,
            statement: kind,
            table,
          });
        }
      }
    });
  }
  return offenders;
}

describe("no feature code writes to L1 canonical MS Graph tables", () => {
  const root = path.resolve(__dirname, "../..");
  const srcDir = path.join(root, "src");

  it("has no INSERT / UPDATE / DELETE against instinct_ms_* outside ms-graph/sync/**", () => {
    const files = walk(srcDir);
    const offenders: Array<{ file: string; line: number; statement: string; table: string }> = [];
    for (const f of files) {
      const rel = path.relative(root, f);
      if (isExempt(rel)) continue;
      offenders.push(...scanFile(f, rel));
    }

    if (offenders.length > 0) {
      const list = offenders
        .map((o) => `  ${o.file}:${o.line} — ${o.statement} against ${o.table}`)
        .join("\n");
      throw new Error(
        `Feature code is writing to L1 canonical MS Graph tables. ` +
          `Use src/lib/entity-tags.ts or src/lib/entity-links.ts (L3) instead.\n${list}\n\n` +
          `See src/db/migrations/078_entity_tags_and_links.sql header for rationale.`,
      );
    }
  });

  // Meta-test: seed a fake offending file in a tmp dir, run the same
  // scanner against it, assert that the guard catches it. This protects
  // the scanner itself from regressing silently.
  it("catches a seeded bad file writing INSERT INTO instinct_ms_events", () => {
    const tmpDir = fs.mkdtempSync(path.join(require("os").tmpdir(), "l1-guard-"));
    const badFile = path.join(tmpDir, "bad-feature.ts");
    fs.writeFileSync(
      badFile,
      `
        import { query } from "@/lib/db";
        export async function badWrite() {
          await query(\`INSERT INTO instinct_ms_events (id) VALUES ($1)\`, ["x"]);
        }
      `,
      "utf8",
    );
    try {
      const offenders = scanFile(badFile, "tmp/bad-feature.ts");
      expect(offenders.length).toBeGreaterThan(0);
      expect(offenders[0].table).toBe("instinct_ms_events");
      expect(offenders[0].statement).toBe("INSERT");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("catches UPDATE and DELETE patterns, not just INSERT", () => {
    const tmpDir = fs.mkdtempSync(path.join(require("os").tmpdir(), "l1-guard-"));
    const updFile = path.join(tmpDir, "upd.ts");
    fs.writeFileSync(
      updFile,
      `await query("UPDATE instinct_ms_tasks SET title='x' WHERE id=$1", ["a"]);`,
      "utf8",
    );
    const delFile = path.join(tmpDir, "del.ts");
    fs.writeFileSync(
      delFile,
      `await query("DELETE FROM instinct_ms_messages WHERE id=$1", ["a"]);`,
      "utf8",
    );
    try {
      const updOff = scanFile(updFile, "tmp/upd.ts");
      const delOff = scanFile(delFile, "tmp/del.ts");
      expect(updOff.some((o) => o.statement === "UPDATE" && o.table === "instinct_ms_tasks")).toBe(true);
      expect(delOff.some((o) => o.statement === "DELETE" && o.table === "instinct_ms_messages")).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("does NOT flag writes under src/lib/ms-graph/sync/**", () => {
    const rel = "src/lib/ms-graph/sync/events-sync.ts";
    expect(isExempt(rel)).toBe(true);
  });

  it("does NOT flag SELECT reads (only writes are forbidden)", () => {
    const tmpDir = fs.mkdtempSync(path.join(require("os").tmpdir(), "l1-guard-"));
    const okFile = path.join(tmpDir, "ok.ts");
    fs.writeFileSync(
      okFile,
      `await safeQuery("SELECT * FROM instinct_ms_events WHERE id=$1", ["a"]);`,
      "utf8",
    );
    try {
      const offenders = scanFile(okFile, "tmp/ok.ts");
      expect(offenders.length).toBe(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
