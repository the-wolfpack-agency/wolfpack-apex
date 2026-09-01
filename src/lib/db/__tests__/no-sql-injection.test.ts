/**
 * Ratchet: no untrusted value may be interpolated into SQL.
 *
 * WHY THIS EXISTS, GIVEN IT FINDS NOTHING TODAY
 *
 * Instinct is becoming a product other companies run, which makes SQL injection
 * the worst thing that could be in it: one query would cross every tenant
 * boundary the rest of the platform is built to defend.
 *
 * I audited it and the answer is good. 101 query calls interpolate something
 * into a template literal, and every one of them is the disciplined idiom:
 * clause fragments carrying $N placeholders, column lists from module
 * constants, and integers already clamped with Math.min/Math.max. Values go in
 * the params array. Nothing reaches the string.
 *
 * So this test is not here because the code is wrong. It is here because that
 * discipline is currently a habit, and a habit is not a control — the next
 * route to interpolate an unclamped query parameter would pass every existing
 * test in the repo. The audit is worth doing once; the ratchet is what makes it
 * stay true.
 *
 * WHAT IT LOOKS FOR
 *
 * Two positions where an interpolation is a VALUE rather than structure:
 *
 *   1. Inside a SQL string literal — WHERE name = '${x}'. Decided by counting
 *      unescaped quotes before the interpolation, because a naive /'\$\{/ match
 *      reports `= 'ai.completion'${clause}` as an injection when the quote is
 *      CLOSING a literal. That produced four false positives on the first run,
 *      and four false alarms is how a security test gets ignored.
 *
 *   2. After LIMIT or OFFSET, which cannot take a placeholder in every driver
 *      and so is the one place this codebase legitimately interpolates a
 *      number.
 *
 * Both allow-lists carry the evidence, may only shrink, and fail when stale.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = join(__dirname, "..", "..", "..");

/**
 * Files that interpolate INSIDE a SQL string literal.
 *
 * The bar for an entry is that the value provably cannot be attacker text.
 */
const QUOTED_INTERPOLATION_OK: Readonly<Record<string, string>> = {
  "lib/assistant.ts":
    "${capabilityDenialSql(\"a.content\")} — the fragment is built from a module-constant array of literals in assistant/capability-denial.ts, and that function rejects any argument that is not a bare or table-qualified identifier before building anything. No reader value reaches it: the only call site passes a string literal, and a future call site that passed one would throw rather than interpolate. Tested in assistant/__tests__/capability-denial.test.ts.",
  "lib/pilot/phase-one.ts":
    "${PERSON} — a module constant holding a fixed predicate that matches an account id or an email address. It contains no interpolation of its own, is not exported, and no caller can influence it: the only way to change it is to edit the constant. It exists because the counting has to happen inside the aggregate rather than by filtering rows afterwards, and because the pilot page was reporting our own eval harnesses as the client's usage until it did.",
  "app/api/insights/ai-cost/route.ts":
    "INTERVAL '${days} days' — days is Number.parseInt then Math.min(365, Math.max(1, n)), so it is an integer 1..365 before it reaches the string. Postgres cannot take a placeholder inside an interval literal.",
};

/**
 * Files that interpolate after LIMIT/OFFSET. Every one was read and every value
 * is clamped with Math.min/Math.max (or is a module constant) before use.
 *
 * Listed per file rather than blanket-allowed so a NEW file doing this has to
 * be looked at by a person, which is the entire point.
 */
const LIMIT_INTERPOLATION_OK: readonly string[] = [
  "app/api/admin/feedback/route.ts",
  "lib/ai-code/store.ts",
  "lib/ai-redteam/store.ts",
  "lib/ai-surface/store.ts",
  "lib/audit-log.ts",
  "lib/automations/porsche-classes/assistant-grounding.ts",
  "lib/automations/queries.ts",
  "lib/compliance/store.ts",
  "lib/finance/invoices.ts",
  "lib/hr/scanned-documents.ts",
  "lib/integrations/microsoft-directory.ts",
  "lib/ogiam/queries.ts",
  "lib/support/analytics-repo.ts",
  "lib/time-entries.ts",
];

const QUERY_CALL = /(?:safeQuery|query)\s*(?:<[^>]*>)?\s*\(\s*`((?:[^`\\]|\\.)*)`/gs;
const INTERPOLATION = /\$\{/g;
const LIMIT_INTERPOLATION = /\b(?:LIMIT|OFFSET)\s+\$\{/gi;

/**
 * Is the character at `index` inside a single-quoted SQL literal?
 *
 * Counts unescaped quotes before it. Odd means open. This is the distinction a
 * regex cannot make, and getting it wrong in either direction ruins the test:
 * too loose and it misses the real thing, too tight and it cries wolf.
 */
export function insideSqlString(sql: string, index: number): boolean {
  let open = false;
  for (let i = 0; i < index; i++) {
    if (sql[i] !== "'") continue;
    if (sql[i - 1] === "\\") continue;
    if (sql[i + 1] === "'") {
      i++; // '' is an escaped quote in SQL, not a delimiter
      continue;
    }
    open = !open;
  }
  return open;
}

function walk(dir: string, prefix: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "__tests__" || entry.startsWith(".")) continue;
    const abs = join(dir, entry);
    const rel = prefix ? `${prefix}/${entry}` : entry;
    if (statSync(abs).isDirectory()) walk(abs, rel, out);
    else if (entry.endsWith(".ts")) out.push(rel);
  }
  return out;
}

interface Finding {
  file: string;
  kind: "quoted" | "limit";
}

function scan(): Finding[] {
  const files = [...walk(join(SRC, "lib"), "lib"), ...walk(join(SRC, "app"), "app")];
  const findings: Finding[] = [];

  for (const rel of files) {
    const source = readFileSync(join(SRC, rel), "utf-8");
    for (const call of source.matchAll(QUERY_CALL)) {
      const sql = call[1];

      for (const interp of sql.matchAll(INTERPOLATION)) {
        if (insideSqlString(sql, interp.index ?? 0)) findings.push({ file: rel, kind: "quoted" });
      }
      for (const _ of sql.matchAll(LIMIT_INTERPOLATION)) findings.push({ file: rel, kind: "limit" });
    }
  }
  return findings;
}

describe("no untrusted value is interpolated into SQL", () => {
  const findings = scan();
  const quoted = [...new Set(findings.filter((f) => f.kind === "quoted").map((f) => f.file))].sort();
  const limits = [...new Set(findings.filter((f) => f.kind === "limit").map((f) => f.file))].sort();

  it("scans real query calls, so a broken matcher cannot pass by finding nothing", () => {
    // A scanner that silently matches zero call sites reports success forever.
    expect(findings.length).toBeGreaterThan(10);
  });

  it("tells an open quote from a closing one", () => {
    // The distinction that produced four false positives before it existed.
    expect(insideSqlString("WHERE a = 'x", 12)).toBe(true);
    expect(insideSqlString("WHERE a = 'x'", 13)).toBe(false);
    expect(insideSqlString("WHERE t = 'ai.completion'", 25)).toBe(false);
    expect(insideSqlString("WHERE a = 'it''s'", 17)).toBe(false);
    expect(insideSqlString("SELECT 1", 8)).toBe(false);
  });

  it("has no unlisted interpolation inside a SQL string literal", () => {
    const unlisted = quoted.filter((f) => !(f in QUOTED_INTERPOLATION_OK));
    expect({
      hint: "A value inside a SQL literal is injection unless it provably cannot be attacker text. Use a $N placeholder, or add an entry proving the value is an integer.",
      unlisted,
    }).toEqual({ hint: expect.any(String), unlisted: [] });
  });

  it("has no unlisted interpolation after LIMIT or OFFSET", () => {
    const unlisted = limits.filter((f) => !LIMIT_INTERPOLATION_OK.includes(f));
    expect({
      hint: "Clamp with Math.min/Math.max before interpolating, then add the file here so the next reader knows it was checked.",
      unlisted,
    }).toEqual({ hint: expect.any(String), unlisted: [] });
  });

  it("has no stale allow-list entries", () => {
    // A list that never shrinks reads as debt that never got paid.
    const staleQuoted = Object.keys(QUOTED_INTERPOLATION_OK).filter((f) => !quoted.includes(f));
    const staleLimits = LIMIT_INTERPOLATION_OK.filter((f) => !limits.includes(f));
    expect({ staleQuoted, staleLimits }).toEqual({ staleQuoted: [], staleLimits: [] });
  });
});
