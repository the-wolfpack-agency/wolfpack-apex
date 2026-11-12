/* FIRST. Imports hoist, so anything below already read process.env. */
import "./load-env";

/**
 * Publish a committed release file to /releases (instinct_releases).
 *
 *   npx tsx scripts/publish-release.ts <path to release JSON> [--dry-run]
 *
 * Replaces the one-off publish-release-<date>.ts scripts: write the release as
 * JSON (written from the merged pull requests, each entry listing its sources)
 * and run this. Keep the file OUTSIDE this repository: the repo is public and
 * release notes name clients. createRelease() upserts on version, so a re-run updates
 * in place. It does not email the team.
 *
 * It also publishes a lines-of-code snapshot (publish-loc-snapshot.ts), so the
 * figure on /releases moves with every release instead of waiting for someone
 * to remember a second script (it sat two months stale that way). --no-loc skips it.
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRelease } from "@/lib/releases";
import { parseReleaseFile } from "@/lib/release-file";

async function main(): Promise<void> {
  const file = process.argv.slice(2).find((a) => !a.startsWith("--"));
  if (!file) { console.error("usage: npx tsx scripts/publish-release.ts <release.json> [--dry-run]"); process.exit(2); }
  const input = parseReleaseFile(readFileSync(file, "utf8"));
  if (process.argv.includes("--dry-run")) {
    console.log(`${input.version} "${input.title}": ${input.entries.length} entries (dry run, nothing written)`);
    return;
  }
  const release = await createRelease({ ...input, created_by: "release-notes" });
  console.log(`published ${release.version}: ${release.entries.length} entries`);
  if (!process.argv.includes("--no-loc")) {
    execFileSync("npx", ["tsx", join(dirname(fileURLToPath(import.meta.url)), "publish-loc-snapshot.ts")], { stdio: "inherit" });
  }
}

main().catch((err) => {
  const e = err as Error & { code?: string; detail?: string };
  console.error("failed:", e.message || "(no message)", e.code ?? "", e.detail ?? "");
  process.exit(1);
});
