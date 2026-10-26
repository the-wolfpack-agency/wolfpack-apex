/**
 * Guardrail: a strict write that asserts a row count must RETURN rows.
 *
 * writeQuery / tx.write compare `expectRows` against result.rows.length.
 * Postgres returns no rows for an UPDATE, DELETE or INSERT without a
 * RETURNING clause, whatever it changed, so `expectRows: 1` on one of
 * those throws on every call, including the successful ones.
 *
 * That shipped three times: POST /api/knowledge/feedback answered 500 on
 * every thumbs-up (the UPDATE succeeded and was then reported as a
 * failure), the cache hit counter never moved (bumpHit swallows the
 * throw), and deleting a site section comment always failed. The
 * soft E2E knowledge-qa-cache spec found the first one once it got far
 * enough to click Helpful.
 *
 * `expectRows: 0` stays legal: it is how callers say "I do not need the
 * count" for a non-RETURNING write.
 */
import fs from "fs";
import path from "path";

const ROOT = path.join(process.cwd(), "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "__tests__") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** Index of the paren that closes the one at `open`, skipping string and
 *  template literals so a ")" inside SQL does not end the call early. */
function closingParen(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "'" || c === '"' || c === "`") {
      const q = c;
      for (i++; i < src.length && src[i] !== q; i++) if (src[i] === "\\") i++;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i;
  }
  return -1;
}

export interface Offender {
  line: number;
  sql: string;
  expectRows: number;
}

/** Every writeQuery(...) / <tx>.write(...) call whose first argument is a
 *  string or template SQL write without RETURNING and whose options assert
 *  expectRows >= 1. Exported shape kept small so the self-test can use it. */
export function findOffenders(src: string): Offender[] {
  const out: Offender[] = [];
  const call = /\b(?:writeQuery|\w+\.write)\s*(?:<[^>()]*>)?\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = call.exec(src))) {
    const open = m.index + m[0].length - 1;
    const close = closingParen(src, open);
    if (close < 0) continue;
    const args = src.slice(open + 1, close);
    const lit = /^\s*(`[^`]*`|"[^"]*"|'[^']*')/.exec(args);
    if (!lit) continue;
    const sql = lit[1];
    if (!/\b(UPDATE|DELETE|INSERT)\b/i.test(sql) || /\bRETURNING\b/i.test(sql)) continue;
    const er = /expectRows\s*:\s*(\d+)/.exec(args.slice(lit[0].length));
    if (!er || Number(er[1]) === 0) continue;
    out.push({
      line: src.slice(0, m.index).split("\n").length,
      sql: sql.replace(/\s+/g, " ").slice(0, 100),
      expectRows: Number(er[1]),
    });
  }
  return out;
}

describe("strict writes that assert a row count must RETURN rows", () => {
  it("the scanner catches the shape it exists for, and passes the fixed one", () => {
    const bad = "await writeQuery(\n  `UPDATE t SET n = n + 1 WHERE id = $1`,\n  [id],\n  { expectRows: 1 },\n);";
    const good = "await writeQuery(`UPDATE t SET n = n + 1 WHERE id = $1 RETURNING id`, [id], { expectRows: 1 });";
    const dontCare = "await tx.write(`UPDATE t SET n = 1 WHERE id = $1`, [id], { expectRows: 0 });";
    const txBad = "await tx.write(`DELETE FROM t WHERE id = (SELECT $1)`, [id], { expectRows: 1 });";
    expect(findOffenders(bad)).toHaveLength(1);
    expect(findOffenders(bad)[0].line).toBe(1);
    expect(findOffenders(good)).toHaveLength(0);
    expect(findOffenders(dontCare)).toHaveLength(0);
    expect(findOffenders(txBad)).toHaveLength(1);
  });

  it("no source file asserts expectRows >= 1 on a write without RETURNING", () => {
    const offenders: string[] = [];
    for (const file of walk(ROOT)) {
      const src = fs.readFileSync(file, "utf8");
      if (!/expectRows/.test(src)) continue;
      for (const o of findOffenders(src)) {
        offenders.push(
          `${path.relative(process.cwd(), file)}:${o.line} expectRows: ${o.expectRows} on ${o.sql}`,
        );
      }
    }
    expect(offenders).toEqual([]);
  });
});
