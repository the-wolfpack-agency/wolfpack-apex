/**
 * Filesystem-backed RepoReader for the readiness engine. Shared by the
 * `npm run readiness` CLI and the CI ratchet test (DRY: one reader, one scan
 * behavior). Node-only (uses fs), deliberately kept out of src/lib so it can
 * never be pulled into a client bundle.
 */
import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";
import type { RepoReader } from "../src/lib/readiness/types";

const SKIP = new Set([
  "node_modules",
  ".next",
  ".git",
  ".vercel",
  "coverage",
  "playwright-report",
  "test-results",
  ".claude",
]);

export function createFsReader(root: string): RepoReader {
  return {
    read(path) {
      try {
        return readFileSync(join(root, path), "utf8");
      } catch {
        return null;
      }
    },
    exists(path) {
      return existsSync(join(root, path));
    },
    listFiles(dir, suffix) {
      const abs = join(root, dir);
      if (!existsSync(abs)) return [];
      const out: string[] = [];
      const walk = (d: string) => {
        for (const name of readdirSync(d)) {
          if (SKIP.has(name)) continue;
          const p = join(d, name);
          const st = statSync(p);
          if (st.isDirectory()) walk(p);
          else if (!suffix || name.endsWith(suffix)) out.push(relative(root, p));
        }
      };
      walk(abs);
      return out;
    },
  };
}
