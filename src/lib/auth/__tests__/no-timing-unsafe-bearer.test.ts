/**
 * GUARDRAIL: no route compares a bearer secret with === / !== (CWE-208).
 *
 * ~35 routes authorized cron/service calls with
 * `authorization === `Bearer ${secret}``, a timing-unsafe secret compare, each
 * inline (also 35 copies of one check). They now go through isAuthorizedBearer
 * (constant-time). This test fails if any route re-introduces an inline
 * bearer-secret equality compare - so the fix can't regress and a new route can't
 * copy the old unsafe pattern.
 */
import fs from "node:fs";
import path from "node:path";

const API_ROOT = path.resolve(__dirname, "../../../app/api");

/** Every .ts under src/app/api, excluding tests. */
function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "__tests__") continue;
      out.push(...routeFiles(p));
    } else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) {
      out.push(p);
    }
  }
  return out;
}

// `X === `Bearer ${secret}`` or the !== form - a timing-unsafe bearer compare.
const UNSAFE_BEARER_COMPARE = /(===|!==)\s*`Bearer \$\{/;

test("no API route inlines a timing-unsafe bearer-secret comparison (use isAuthorizedBearer)", () => {
  const offenders = routeFiles(API_ROOT)
    .filter((f) => UNSAFE_BEARER_COMPARE.test(fs.readFileSync(f, "utf8")))
    .map((f) => path.relative(API_ROOT, f));
  expect(offenders).toEqual([]);
});
