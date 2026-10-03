/** Guardrail: the factory (ai-code) routes must resolve the tenant through the
 *  resolveWorkspace chokepoint, never the inline `workspaceId ?? "default"`
 *  coalescing that silently pools tenants. This locks the MIGRATED surface so it
 *  cannot regress while the repo-wide migration (150+ sites) + DB-level RLS are
 *  completed separately. Mirrors no-raw-api-fetch.test.ts. */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(process.cwd(), "src/app/api/admin/ai-code");
const COALESCE = /workspaceId\s*\?\?\s*"default"/;

function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...routeFiles(p));
    else if (name === "route.ts") out.push(p);
  }
  return out;
}

describe("ai-code routes: no silent tenant coalescing", () => {
  it("every factory route resolves the workspace via resolveWorkspace, not `?? \"default\"`", () => {
    const offenders = routeFiles(ROOT).filter((f) => COALESCE.test(readFileSync(f, "utf8")));
    expect(offenders.map((f) => f.replace(process.cwd() + "/", ""))).toEqual([]);
  });
});
