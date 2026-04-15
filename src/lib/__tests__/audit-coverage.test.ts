/**
 * audit-coverage.test.ts
 *
 * For every API route that exports a mutation handler (POST / PUT / PATCH /
 * DELETE), assert that the file imports `recordAudit` from `@/lib/audit-log`
 * OR is explicitly allowlisted in `AUDIT_ALLOWLIST`.
 *
 * This test catches the regression where someone adds a new mutation route
 * without wiring in audit logging.
 */

import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";
import { AUDIT_ALLOWLIST_ROUTES } from "@/__tests__/AUDIT_ALLOWLIST";

const REPO = join(__dirname, "..", "..", "..");
const API_ROOT = join(REPO, "src", "app", "api");
const MUTATION_REGEX = /\bexport\s+async\s+function\s+(POST|PUT|PATCH|DELETE)\b/;
const AUDIT_IMPORT_REGEX = /from\s+["']@\/lib\/audit-log["']/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (name === "route.ts") out.push(full);
  }
  return out;
}

describe("every mutation API route either audits or is allowlisted", () => {
  const routes = walk(API_ROOT);

  it("finds at least one route (sanity)", () => {
    expect(routes.length).toBeGreaterThan(10);
  });

  it.each(
    routes.map((r) => [relative(REPO, r).replace(/\\/g, "/"), r] as [string, string]),
  )("%s", (rel, abs) => {
    const src = readFileSync(abs, "utf8");
    if (!MUTATION_REGEX.test(src)) {
      // No mutation handler — nothing to audit.
      return;
    }

    if (AUDIT_IMPORT_REGEX.test(src)) return; // good

    if (AUDIT_ALLOWLIST_ROUTES.has(rel)) return; // explicitly allowed

    throw new Error(
      `Route ${rel} has a mutation handler but neither imports recordAudit nor is listed in src/__tests__/AUDIT_ALLOWLIST.ts. ` +
        `Either add \`import { recordAudit } from "@/lib/audit-log";\` and call it in the handler, or add an entry to AUDIT_ALLOWLIST with a reason.`,
    );
  });
});
