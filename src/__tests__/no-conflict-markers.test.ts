/**
 * Guardrail: no committed VCS merge-conflict markers, anywhere under src/.
 *
 * This exact failure jammed the factory PR series: a `git stash` juggle left
 * `<<<<<<<` / `>>>>>>>` markers in a committed file, which compiled-failed CI and
 * needed a human to notice and fix. It is fully preventable, so it is now a
 * deterministic gate: a marker in any source file fails the build here, before it
 * can reach a PR. Same rule the factory enforces on the code it authors
 * (containsConflictMarkers in file-changes.ts) - one source of truth for "this is
 * a broken merge", applied to our repo and to the tool's output alike.
 */
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { containsConflictMarkers } from "@/lib/ai-code/file-changes";

const SRC = join(process.cwd(), "src");
const SKIP_DIRS = new Set(["node_modules", ".next", "dist", "coverage"]);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx|js|jsx|json|css|scss|md|sql|ya?ml)$/.test(name)) out.push(full);
  }
  return out;
}

test("no source file contains a merge-conflict marker", () => {
  // This test file names the markers in its own docstring by necessity, so scan by
  // the shared detector (which keys on line-start markers) and exclude self.
  const self = __filename;
  const offenders = walk(SRC)
    .filter((f) => f !== self)
    .filter((f) => containsConflictMarkers(readFileSync(f, "utf8")))
    .map((f) => f.replace(process.cwd() + "/", ""));
  expect(offenders).toEqual([]);
});
