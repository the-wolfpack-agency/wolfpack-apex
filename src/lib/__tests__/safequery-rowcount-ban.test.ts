/**
 * Scanner test: `safeQuery()` does NOT expose pg's `rowCount` — it
 * returns `{ rows, fromCache }`. Any code that reads `result.rowCount`
 * from a `safeQuery` call-site silently always sees 0, which means
 * DELETE / UPDATE handlers falsely report "no row affected" and the
 * UI toasts "Failed to ...".
 *
 * This bug shipped 6 times across the repo (knowledge, clients, people,
 * feature-requests, doc-generator, discussions) before the user caught
 * it in production. Fix: DELETE ... RETURNING id, then read rows.length.
 *
 * Codify the ban here so CI fails if the pattern re-enters the tree.
 *
 * Allow-list: `src/lib/db.ts` itself (defines the API) and files that
 * use the raw `query()` (returns a pg QueryResult with rowCount).
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const SRC = resolve(__dirname, "../../");

function walk(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    // Skip node_modules, tests, dist, next build output.
    if (name === "node_modules" || name === "__tests__" || name === ".next") continue;
    const full = join(dir, name);
    let s;
    try {
      s = statSync(full);
    } catch {
      continue;
    }
    if (s.isDirectory()) {
      out.push(...walk(full));
    } else if (s.isFile() && (full.endsWith(".ts") || full.endsWith(".tsx"))) {
      if (full.includes(".test.") || full.includes(".spec.")) continue;
      out.push(full);
    }
  }
  return out;
}

describe("safeQuery result must never be read for rowCount", () => {
  it("no source file pairs safeQuery() with a rowCount access", () => {
    const files = walk(SRC);
    const offenders: string[] = [];
    for (const file of files) {
      // Allow src/lib/db.ts to define the API.
      if (file.endsWith("/lib/db.ts")) continue;
      const source = readFileSync(file, "utf8");
      // Only inspect files that actually call safeQuery.
      if (!/\bsafeQuery\s*(?:<[^>]*>)?\s*\(/.test(source)) continue;
      // Heuristic: if the file calls safeQuery AND touches rowCount
      // AND does NOT also call the raw `query(` (indicating it might
      // mix both), flag it. Files that use BOTH safeQuery and query
      // still fail this test — that's intentional; the mixed usage
      // has caused bugs too. Fix the ambiguity by using RETURNING.
      if (/\browCount\b/.test(source)) {
        // Look for the specific anti-pattern: a cast-and-read of
        // rowCount applied to a safeQuery result.
        const hasAntiPattern =
          /as\s+unknown\s+as\s+\{\s*rowCount\??:\s*number\s*\}/.test(source) ||
          /\.\s*rowCount\s*\)\s*\?\?\s*0/.test(source);
        if (hasAntiPattern) {
          offenders.push(file.replace(SRC + "/", ""));
        }
      }
    }
    if (offenders.length > 0) {
      throw new Error(
        "The following files read rowCount from a safeQuery() result — " +
          "safeQuery returns { rows, fromCache } only. Use " +
          "`DELETE ... RETURNING id` + rows.length instead.\n" +
          offenders.map((f) => "  " + f).join("\n"),
      );
    }
  });
});
