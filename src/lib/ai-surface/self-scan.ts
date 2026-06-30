/**
 * Self-scan: run the AI-surface detectors over THIS repo (dogfood the same
 * read-only scan we offer clients as the free wedge). Produces a real inventory
 * we can cite in a case study and re-run any time.
 *
 * Split so the logic is unit-testable with no filesystem: `summarizeSelfScan` is
 * pure over an in-memory file set and reuses the exact production rollup
 * (detectAiSurfaces + summarize + remediateAll), and `collectRepoFiles` is the
 * thin fs walk that feeds it. Nothing here writes or persists; it is a read.
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { detectAiSurfaces, type SourceFile } from "./detect";
import { summarize, type AiSurfaceRecord } from "./store";
import { remediationFor, type Remediation } from "./remediation";
import type { AiSurface, AiSurfaceSummary } from "./types";

/** Directories never worth scanning (deps, build output, vcs, coverage). */
export const IGNORE_DIRS: ReadonlySet<string> = new Set([
  "node_modules", ".next", ".git", "dist", "build", "coverage", ".turbo", ".vercel", ".claude",
]);

/** Extensions the detectors can meaningfully read (code + config/env-ish text). */
export const SCAN_EXTENSIONS: ReadonlySet<string> = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".env", ".example", ".yml", ".yaml",
]);

/** Pure: should this path be scanned? (extension allowed AND not under an ignored dir). */
export function shouldScanFile(relPath: string): boolean {
  const parts = relPath.split(path.sep);
  if (parts.some((p) => IGNORE_DIRS.has(p))) return false;
  const base = parts[parts.length - 1];
  const ext = base.includes(".") ? base.slice(base.lastIndexOf(".")) : "";
  return SCAN_EXTENSIONS.has(ext);
}

export interface SelfScanResult {
  filesScanned: number;
  surfaces: AiSurface[];
  summary: AiSurfaceSummary;
  /** Remediations for the ungoverned gap only (governed surfaces need no fix). */
  remediations: Remediation[];
}

/**
 * PURE rollup over an in-memory file set. Identical detector + summarize +
 * remediation path as the live /admin/ai-surfaces scan, so the case-study
 * numbers are the product's real numbers, not a parallel implementation.
 */
export function summarizeSelfScan(files: SourceFile[]): SelfScanResult {
  const surfaces = files.flatMap((f) => detectAiSurfaces(f));
  const asRecords: AiSurfaceRecord[] = surfaces.map((s, i) => ({
    ...s,
    id: String(i),
    target: "self",
    firstSeenAt: "",
    lastSeenAt: "",
  }));
  const remediations = surfaces.filter((s) => !s.governed).map(remediationFor);
  return { filesScanned: files.length, surfaces, summary: summarize(asRecords), remediations };
}

/** Thin fs walk: collect scannable files under `root` as {path, content}. */
export function collectRepoFiles(root: string): SourceFile[] {
  const out: SourceFile[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORE_DIRS.has(entry.name)) walk(abs);
        continue;
      }
      const rel = path.relative(root, abs);
      if (!shouldScanFile(rel)) continue;
      try {
        out.push({ path: rel, content: fs.readFileSync(abs, "utf8") });
      } catch {
        // unreadable file (permissions, binary mislabeled) -> skip, never throw
      }
    }
  };
  walk(root);
  return out;
}

/**
 * Collect TRACKED, scannable files via `git ls-files` so the scan respects
 * .gitignore (no node_modules, no build output, no local artifacts like a
 * gitignored jest-results.json that would otherwise inflate the count with
 * fixtures). Returns null when not in a git repo or git is unavailable, so the
 * caller can fall back to the plain fs walk.
 */
export function collectTrackedFiles(root: string): SourceFile[] | null {
  let listed: string;
  try {
    listed = execFileSync("git", ["-C", root, "ls-files", "-z"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return null;
  }
  const out: SourceFile[] = [];
  for (const rel of listed.split("\0")) {
    if (!rel || !shouldScanFile(rel)) continue;
    try {
      out.push({ path: rel, content: fs.readFileSync(path.join(root, rel), "utf8") });
    } catch {
      // unreadable / deleted-but-staged -> skip, never throw
    }
  }
  return out;
}

/**
 * Convenience: collect `root`'s scannable files and summarize in one call (used
 * by the CLI script). Prefers tracked files (respects .gitignore); falls back to
 * the fs walk outside a git repo.
 */
export function runSelfScan(root: string): SelfScanResult {
  return summarizeSelfScan(collectTrackedFiles(root) ?? collectRepoFiles(root));
}
