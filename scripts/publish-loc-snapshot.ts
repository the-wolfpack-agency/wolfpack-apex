/**
 * Publish a lines-of-code snapshot across the portfolio.
 *
 * The `loc` field already exists on a release entry (src/lib/releases.ts) and
 * backfill-release-notes.ts computes it per repo for creation milestones. What
 * was missing is a way to record where the codebase stands NOW, so the number
 * on the releases page is current rather than frozen at each project's first
 * commit.
 *
 * Counting method is deliberately the same one backfill already uses, so the
 * two numbers are comparable:
 *   - only files git tracks, which excludes node_modules and build output
 *     without needing an ignore list of its own
 *   - source extensions only
 *   - vendored, generated and minified trees excluded, plus .d.ts, so the
 *     figure reflects code the team wrote rather than code it installed
 *
 * A repo that cannot be read contributes 0 and is named in the output. Silently
 * dropping it would understate the total and look like a shrinking codebase.
 *
 * Usage:  npx tsx scripts/publish-loc-snapshot.ts [--dry-run]
 * Needs:  DATABASE_URL, and the sibling repos checked out under mono/
 */
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRelease, type ReleaseEntry } from "@/lib/releases";

const MONO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DRY = process.argv.includes("--dry-run");

/** Repo folder -> the product area it reports under. */
const REPOS: { dir: string; area: string }[] = [
  { dir: "wolfpack-apex", area: "Instinct" },
  { dir: "wolfpack-auto", area: "Auto" },
  { dir: "AgenticQA", area: "AgenticQA" },
  { dir: "wolfpack-beyond", area: "Beyond" },
  { dir: "wolfpack-porsche-weekend", area: "A Weekend with Porsche" },
  { dir: "wolfpack-lms", area: "LMS" },
  { dir: "wolfpack-site-template", area: "Site Template" },
];

/** Same counting method as backfill-release-notes.ts, so the numbers compare. */
function linesOfCode(dir: string): number | null {
  const abs = join(MONO, dir);
  if (!existsSync(join(abs, ".git"))) return null;
  try {
    const cmd =
      `cd '${abs}' && git ls-files -z -- ` +
      `'*.ts' '*.tsx' '*.js' '*.jsx' '*.mjs' '*.cjs' '*.py' '*.sql' '*.css' '*.scss' ` +
      `| grep -zvE '(^|/)(vendor|dist|build|coverage|__generated__)/|\\.d\\.ts$|\\.min\\.(js|css)$' ` +
      `| xargs -0 cat 2>/dev/null | wc -l`;
    const out = execSync(cmd, { encoding: "utf8", maxBuffer: 512 * 1024 * 1024, shell: "/bin/bash" });
    const n = parseInt(out.trim(), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const measured: { area: string; dir: string; loc: number }[] = [];
  const unreadable: string[] = [];

  for (const r of REPOS) {
    const loc = linesOfCode(r.dir);
    if (loc == null) {
      unreadable.push(r.dir);
      continue;
    }
    measured.push({ area: r.area, dir: r.dir, loc });
  }

  measured.sort((a, b) => b.loc - a.loc);
  const total = measured.reduce((n, m) => n + m.loc, 0);

  const entries: ReleaseEntry[] = measured.map((m) => ({
    title: `${m.area}: ${m.loc.toLocaleString()} lines`,
    description: `${m.area} contains ${m.loc.toLocaleString()} lines of team-authored source, counted from files tracked by git (excludes dependencies, build output, generated and minified files, and type declarations).`,
    how_to_use: "",
    area: m.area,
    category: "milestone",
    loc: m.loc,
  }));

  const summary =
    `${total.toLocaleString()} lines of team-authored source across ${measured.length} repositories, as of today. ` +
    `Counted from files tracked by git, so dependencies and build output are excluded automatically.` +
    (unreadable.length ? ` Not counted (repository not available on this machine): ${unreadable.join(", ")}.` : "");

  console.log(`[loc] ${total.toLocaleString()} total across ${measured.length} repos`);
  for (const m of measured) console.log(`  ${m.area.padEnd(26)} ${m.loc.toLocaleString().padStart(9)}`);
  if (unreadable.length) console.log(`  unreadable: ${unreadable.join(", ")}`);

  if (DRY) {
    console.log("[loc] DRY RUN: nothing written");
    return;
  }

  const rel = await createRelease({
    // Dated version: a snapshot is a point in time, and upsert-on-version means
    // re-running on the same day corrects the figure rather than duplicating it.
    version: `loc-snapshot-${new Date().toISOString().slice(0, 10)}`,
    title: `Codebase snapshot: ${total.toLocaleString()} lines`,
    summary,
    released_on: new Date().toISOString().slice(0, 10),
    entries,
    published: true,
    created_by: "loc-snapshot",
  });
  console.log(`[loc] published ${rel.version}`);
}

main().catch((err) => {
  console.error("[loc] failed:", (err as Error).message);
  process.exit(1);
});
