#!/usr/bin/env node
/**
 * Vendor the portable Forcefield-web core into a connected site.
 *
 *   node scripts/forcefield-vendor.mjs /path/to/target-repo
 *
 * Copies exactly the files listed in src/lib/forcefield-web/vendor-manifest.json
 * into <target>/<targetDir>, and writes a VENDORED.md marker recording the source
 * so the copy is obviously generated (edit in apex, re-run this, never by hand).
 * This is the DRY seam: the ENGINE is vendored (rarely changes); the RULES update
 * centrally via /api/forcefield/ruleset (see ruleset.ts). Idempotent.
 */
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const manifest = JSON.parse(readFileSync(join(repoRoot, "src/lib/forcefield-web/vendor-manifest.json"), "utf8"));

const target = process.argv[2];
if (!target) {
  console.error("usage: node scripts/forcefield-vendor.mjs <target-repo-root>");
  process.exit(1);
}

const srcDir = join(repoRoot, manifest.sourceDir);
const dstDir = join(target, manifest.targetDir);
mkdirSync(dstDir, { recursive: true });

for (const f of manifest.files) {
  copyFileSync(join(srcDir, f), join(dstDir, f));
  console.log(`  vendored ${f}`);
}
// The manifest travels too, so the target can be re-synced / audited.
copyFileSync(join(srcDir, "vendor-manifest.json"), join(dstDir, "vendor-manifest.json"));

writeFileSync(
  join(dstDir, "VENDORED.md"),
  [
    "# Vendored: Forcefield-web core",
    "",
    "GENERATED - do not edit here. Source of truth: `the-wolfpack-agency/wolfpack-apex` `src/lib/forcefield-web/`.",
    "Re-sync with `node scripts/forcefield-vendor.mjs <this-repo>` from apex.",
    "",
    "The ENGINE is vendored (stable). The RULES (scanners, allowlists, trap paths)",
    "update centrally via `/api/forcefield/ruleset` - no re-vendor needed for those.",
    "",
    `Files: ${manifest.files.join(", ")}`,
    "",
  ].join("\n"),
);
console.log(`\nVendored ${manifest.files.length} files -> ${dstDir}`);
