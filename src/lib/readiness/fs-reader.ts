/**
 * Filesystem-backed RepoReader - lets the readiness engine run against the REAL
 * repo (not just a fake map in tests). Pure reads, rooted at a base dir, so the
 * runner script and any route can grade the live tree. Kept tiny and dependency-
 * free; the engine stays the single source of grading logic.
 */
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { RepoReader } from "./types";

export function createFsRepoReader(root: string): RepoReader {
  const abs = (p: string) => join(root, p);
  return {
    read(path: string): string | null {
      try {
        return readFileSync(abs(path), "utf8");
      } catch {
        return null;
      }
    },
    exists(path: string): boolean {
      return existsSync(abs(path));
    },
    listFiles(dir: string, suffix?: string): string[] {
      const start = abs(dir);
      if (!existsSync(start)) return [];
      const out: string[] = [];
      const walk = (d: string) => {
        let entries: string[];
        try {
          entries = readdirSync(d);
        } catch {
          return;
        }
        for (const name of entries) {
          if (name === "node_modules" || name === ".next" || name === ".git") continue;
          const full = join(d, name);
          let isDir = false;
          try {
            isDir = statSync(full).isDirectory();
          } catch {
            continue;
          }
          if (isDir) walk(full);
          else if (!suffix || name.endsWith(suffix)) {
            // Return repo-relative, forward-slash paths so matchers written with
            // "/" work on every platform.
            out.push(relative(root, full).split(sep).join("/"));
          }
        }
      };
      walk(start);
      return out;
    },
  };
}
