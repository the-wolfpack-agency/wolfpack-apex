/**
 * Filesystem side of the DRY gate: walk src, compute the current
 * function/class export collisions, and load the accepted baseline. Kept
 * separate from the pure detector (duplicate-exports.ts) so both the CLI
 * (scripts/scan-duplicate-exports.ts) and the jest guardrail reuse ONE walk.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { indexFunctionClassExports, findCollisions, type SourceFile } from "./duplicate-exports";

export const SRC_DIR = join(__dirname, "..", "..");
export const BASELINE_PATH = join(SRC_DIR, "lib", "dev", "__generated__", "duplicate-exports-baseline.json");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === "__tests__" || e.startsWith(".")) continue;
    const abs = join(dir, e);
    if (statSync(abs).isDirectory()) out.push(...walk(abs));
    else if (/\.(ts|tsx)$/.test(e) && !/\.(test|spec)\./.test(e)) out.push(abs);
  }
  return out;
}

/** name -> sorted files, for every function/class exported from >1 file today. */
export function currentCollisions(): Record<string, string[]> {
  const files: SourceFile[] = walk(SRC_DIR).map((abs) => ({
    path: abs.slice(SRC_DIR.length + 1),
    content: readFileSync(abs, "utf8"),
  }));
  return findCollisions(indexFunctionClassExports(files));
}

export function loadBaseline(): Record<string, string[]> {
  return JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Record<string, string[]>;
}
