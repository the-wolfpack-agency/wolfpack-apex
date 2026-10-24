/**
 * Production-readiness engine - shared static-scan helpers.
 *
 * One set of repo-scanning primitives every tool's collectSignals reuses (DRY):
 * read files, count files by suffix under a dir, and test whether any file in a
 * set matches a pattern. All operate on the injected RepoReader, so they are pure
 * and the tool collectors stay hermetic under test.
 *
 * Evidence, not mentions. Every match runs against the file with its COMMENTS
 * REMOVED (TS/JS, SQL and YAML), because a criterion satisfied by a comment is
 * satisfied without the control existing: the audit found `isolation-db-enforced`
 * reading "ready" off a SQL comment that only described a policy. Negative checks
 * ("no X in the routes") additionally require the files to exist, so a deleted or
 * renamed surface can never read "ready" by absence.
 */
import type { RepoReader } from "./types";

/** Files under any of `dirs` (recursive) whose basename ends with `suffix`. */
export function filesUnder(reader: RepoReader, dirs: readonly string[], suffix?: string): string[] {
  return dirs.flatMap((d) => reader.listFiles(d, suffix));
}

// ---------------------------------------------------------------------------
// Comment stripping
// ---------------------------------------------------------------------------

/** Remove // and block comments from TS/JS, keeping string, template and regex
 *  literal contents intact (a URL in a string is not a comment). */
export function stripJsComments(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  // The last significant (non-space) char emitted, to tell a regex from division.
  let prev = "";
  const regexCanFollow = (c: string) => c === "" || "(,=:[!&|?{};+-*%<>~^".includes(c);
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === "/" && d === "/") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && d === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] === "\n") out += "\n";
        i++;
      }
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      out += c;
      i++;
      while (i < n && src[i] !== q) {
        if (src[i] === "\\" && i + 1 < n) {
          out += src[i] + src[i + 1];
          i += 2;
          continue;
        }
        out += src[i];
        i++;
      }
      if (i < n) out += src[i++];
      prev = q;
      continue;
    }
    if (c === "/" && regexCanFollow(prev)) {
      // Regex literal: copy to the closing unescaped slash (outside a class).
      out += c;
      i++;
      let inClass = false;
      while (i < n && src[i] !== "\n") {
        const r = src[i];
        if (r === "\\" && i + 1 < n) {
          out += r + src[i + 1];
          i += 2;
          continue;
        }
        if (r === "[") inClass = true;
        else if (r === "]") inClass = false;
        out += r;
        i++;
        if (r === "/" && !inClass) break;
      }
      prev = "/";
      continue;
    }
    out += c;
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out;
}

/** Remove `--` and block comments from SQL, keeping quoted strings intact. */
export function stripSqlComments(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === "-" && d === "-") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && d === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (c === "'") {
      out += c;
      i++;
      while (i < n) {
        if (src[i] === "'" && src[i + 1] === "'") {
          out += "''";
          i += 2;
          continue;
        }
        out += src[i];
        if (src[i++] === "'") break;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Remove YAML `#` comments (line start or after whitespace, outside quotes). */
export function stripYamlComments(src: string): string {
  return src
    .split("\n")
    .map((line) => {
      let quote: string | null = null;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (quote) {
          if (c === quote) quote = null;
          continue;
        }
        if (c === '"' || c === "'") quote = c;
        else if (c === "#" && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
      }
      return line;
    })
    .join("\n");
}

/** Strip comments by file extension. Unknown types are returned unchanged. */
export function codeOf(path: string, content: string): string {
  if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(path)) return stripJsComments(content);
  if (/\.sql$/.test(path)) return stripSqlComments(content);
  if (/\.ya?ml$/.test(path)) return stripYamlComments(content);
  return content;
}

/** File contents with comments removed, or null when the file does not exist. */
export function readCode(reader: RepoReader, path: string): string | null {
  const c = reader.read(path);
  return c == null ? null : codeOf(path, c);
}

// ---------------------------------------------------------------------------
// Matchers (all on comment-stripped code)
// ---------------------------------------------------------------------------

/** true when ANY file under `dirs` (optionally filtered by suffix) matches `re`. */
export function anyFileMatches(
  reader: RepoReader,
  dirs: readonly string[],
  re: RegExp,
  suffix?: string,
): boolean {
  for (const p of filesUnder(reader, dirs, suffix)) {
    const c = readCode(reader, p);
    if (c && reMatch(re, c)) return true;
  }
  return false;
}

/** true when files exist under `dirs` AND none of them matches `re`. A missing
 *  surface is never "clean by absence". */
export function noFileMatches(
  reader: RepoReader,
  dirs: readonly string[],
  re: RegExp,
  suffix?: string,
): boolean {
  const files = filesUnder(reader, dirs, suffix);
  if (files.length === 0) return false;
  return !files.some((p) => {
    const c = readCode(reader, p);
    return c != null && reMatch(re, c);
  });
}

/** true when a specific file exists and matches `re`. */
export function fileMatches(reader: RepoReader, path: string, re: RegExp): boolean {
  const c = readCode(reader, path);
  return c != null && reMatch(re, c);
}

/** true when a specific file EXISTS and does not match `re`. */
export function fileLacks(reader: RepoReader, path: string, re: RegExp): boolean {
  const c = readCode(reader, path);
  return c != null && !reMatch(re, c);
}

/** A global regex is stateful (lastIndex); test on a fresh copy so repeated calls
 *  are deterministic. */
function reMatch(re: RegExp, s: string): boolean {
  return new RegExp(re.source, re.flags.replace("g", "")).test(s);
}

// ---------------------------------------------------------------------------
// SQL statements
// ---------------------------------------------------------------------------

/** Every SQL statement fragment across the migrations (comments removed, split
 *  on `;`, including fragments inside DO $$ ... $$ blocks). */
export function migrationStatements(reader: RepoReader, dirs: readonly string[] = ["src/db/migrations"]): string[] {
  return filesUnder(reader, dirs, ".sql").flatMap((p) =>
    (readCode(reader, p) ?? "")
      .split(";")
      .map((s) => s.replace(/\s+/g, " ").trim())
      .filter(Boolean),
  );
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A real (non-USING(true)) policy on `table` keyed on `current_setting(guc`. */
export function hasSessionVarPolicy(statements: readonly string[], table: string, guc: string): boolean {
  const re = new RegExp(
    `\\bCREATE POLICY\\s+"?[\\w-]+"?\\s+ON\\s+(?:public\\.)?"?${esc(table)}"?\\b[\\s\\S]*\\bUSING\\s*\\([\\s\\S]*current_setting\\(\\s*'${esc(guc)}`,
    "i",
  );
  return statements.some((s) => re.test(s));
}

/** `ALTER TABLE <table> FORCE ROW LEVEL SECURITY` - without it the table owner
 *  (the app role here) bypasses every policy, so the policy never executes. */
export function hasForcedRls(statements: readonly string[], table: string): boolean {
  const re = new RegExp(`\\bALTER TABLE\\s+(?:IF EXISTS\\s+)?(?:ONLY\\s+)?(?:public\\.)?"?${esc(table)}"?\\s+FORCE ROW LEVEL SECURITY`, "i");
  return statements.some((s) => re.test(s));
}

/** The table is created or altered with a workspace_id column in one statement. */
export function tableHasColumn(statements: readonly string[], table: string, column: string): boolean {
  const re = new RegExp(
    `\\b(?:CREATE TABLE\\s+(?:IF NOT EXISTS\\s+)?|ALTER TABLE\\s+(?:IF EXISTS\\s+)?(?:ONLY\\s+)?)(?:public\\.)?"?${esc(table)}"?[\\s(][\\s\\S]*\\b${esc(column)}\\b`,
    "i",
  );
  return statements.some((s) => re.test(s));
}

/** A BEFORE UPDATE/DELETE trigger on a table matching `tablePrefix`. */
export function hasImmutabilityTrigger(statements: readonly string[], tablePrefix: string): boolean {
  const re = new RegExp(
    `\\bCREATE (?:OR REPLACE )?TRIGGER\\s+\\w+\\s+BEFORE\\s+(?:UPDATE|DELETE)(?:\\s+OR\\s+(?:UPDATE|DELETE))?\\s+ON\\s+(?:public\\.)?${esc(tablePrefix)}\\w*`,
    "i",
  );
  return statements.some((s) => re.test(s));
}

// ---------------------------------------------------------------------------
// Tests and workflows
// ---------------------------------------------------------------------------

/** A *.db.test.ts that actually exercises a real database: it reads
 *  TEST_DATABASE_URL, declares at least one test case, and does not mock the
 *  db layer or the driver. A placeholder file is not a DB test. */
export function isRealDbTest(reader: RepoReader, path: string): boolean {
  const c = readCode(reader, path);
  if (!c) return false;
  if (/jest\.mock\(\s*["'](?:@\/lib\/db|pg)["']/.test(c)) return false;
  return /TEST_DATABASE_URL/.test(c) && /\b(?:it|test)(?:\.each\([^)]*\))?\s*\(/.test(c);
}

/** Count of REAL *.db.test.ts files under the given dirs. */
export function dbTestCount(reader: RepoReader, dirs: readonly string[]): number {
  return filesUnder(reader, dirs, ".db.test.ts").filter((p) => isRealDbTest(reader, p)).length;
}

/**
 * Whether a Playwright e2e spec is run by a workflow on `pull_request` (so a
 * regression blocks a PR, not just a post-merge soft step). Heuristic but
 * deterministic: some workflow file references the spec path AND declares a
 * pull_request trigger. Caller passes the workflow texts (comments removed).
 */
export function specGatesOnPR(workflowTexts: readonly string[], specPath: string): boolean {
  return workflowTexts.some(
    // `/^on:/m` anchors to the start of any line (the YAML trigger key), properly
    // grouped - no missing-anchor precedence trap. Plus a pull_request trigger.
    (t) => t.includes(specPath) && /^on:/m.test(t) && /pull_request/.test(t),
  );
}

/** All workflow file contents with YAML comments removed (a commented-out
 *  trigger or spec path is not a gate). */
export function workflowTexts(reader: RepoReader): string[] {
  return reader
    .listFiles(".github/workflows")
    .filter((p) => p.endsWith(".yml") || p.endsWith(".yaml"))
    .map((p) => readCode(reader, p) ?? "");
}
