#!/usr/bin/env node
/**
 * Vendor the portable Forcefield-web core into a connected site.
 *
 *   node scripts/forcefield-vendor.mjs /path/to/target-repo [--target-dir <dir>]
 *
 * Copies exactly the files listed in src/lib/forcefield-web/vendor-manifest.json
 * into <target>/<targetDir>, and writes a VENDORED.md marker recording the source
 * (and the apex commit it came from) so the copy is obviously generated (edit in
 * apex, re-run this, never by hand). This is the DRY seam: the ENGINE is vendored
 * (rarely changes); the RULES update centrally via /api/forcefield/ruleset (see
 * ruleset.ts). Idempotent.
 *
 * Where the copy lands, in priority order:
 *   1. --target-dir <dir>, relative to the target repo root.
 *   2. An EXISTING vendored copy (a dir holding VENDORED.md) at one of
 *      KNOWN_LAYOUTS, so a site whose app lives at the repo root (lib/, as on
 *      weekendwithporsche) is re-synced in place rather than gaining a second,
 *      unused copy under src/. More than one existing copy is refused.
 *   3. The manifest's targetDir (src/lib/forcefield-web).
 */
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from "node:fs";
import { join, dirname, isAbsolute, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const manifest = JSON.parse(readFileSync(join(repoRoot, "src/lib/forcefield-web/vendor-manifest.json"), "utf8"));

/** Layouts a site may vendor into: Next.js under src/ or at the repo root. */
export const KNOWN_LAYOUTS = ["src/lib/forcefield-web", "lib/forcefield-web"];

function usage(msg) {
  if (msg) console.error(msg);
  console.error("usage: node scripts/forcefield-vendor.mjs <target-repo-root> [--target-dir <dir>]");
  process.exit(1);
}

const args = process.argv.slice(2);
let target = null;
let explicitDir = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--target-dir") {
    explicitDir = args[++i];
    if (!explicitDir) usage("--target-dir needs a value");
  } else if (args[i].startsWith("--target-dir=")) {
    explicitDir = args[i].slice("--target-dir=".length);
  } else if (!target) {
    target = args[i];
  } else {
    usage(`unexpected argument: ${args[i]}`);
  }
}
if (!target) usage();

if (explicitDir !== null) {
  const n = normalize(explicitDir);
  if (!n || isAbsolute(n) || n === ".." || n.startsWith(".." + sep)) usage("--target-dir must be a path inside the target repo");
}

function resolveTargetDir() {
  if (explicitDir !== null) return { dir: normalize(explicitDir), why: "--target-dir" };
  const existing = KNOWN_LAYOUTS.filter((d) => existsSync(join(target, d, "VENDORED.md")));
  if (existing.length > 1) {
    usage(`more than one vendored copy found (${existing.join(", ")}); pass --target-dir to pick one`);
  }
  if (existing.length === 1) return { dir: existing[0], why: "existing vendored copy" };
  return { dir: manifest.targetDir, why: "manifest default" };
}

function sourceCommit() {
  try {
    return execFileSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

const { dir: targetDir, why } = resolveTargetDir();
const srcDir = join(repoRoot, manifest.sourceDir);
const dstDir = join(target, targetDir);
mkdirSync(dstDir, { recursive: true });

for (const f of manifest.files) {
  copyFileSync(join(srcDir, f), join(dstDir, f));
  console.log(`  vendored ${f}`);
}
// The manifest travels too, so the target can be re-synced / audited.
copyFileSync(join(srcDir, "vendor-manifest.json"), join(dstDir, "vendor-manifest.json"));

const commit = sourceCommit();
writeFileSync(
  join(dstDir, "VENDORED.md"),
  [
    "# Vendored: Forcefield-web core",
    "",
    "GENERATED - do not edit here. Source of truth: `the-wolfpack-agency/wolfpack-apex` `src/lib/forcefield-web/`.",
    `Vendored from apex commit \`${commit}\`.`,
    `Re-sync with \`node scripts/forcefield-vendor.mjs <this-repo>\` from apex (lands in \`${targetDir}\`).`,
    "",
    "The ENGINE is vendored (stable). The RULES (scanners, allowlists, trap paths)",
    "update centrally via `/api/forcefield/ruleset` - no re-vendor needed for those.",
    "",
    `Files: ${manifest.files.join(", ")}`,
    "",
  ].join("\n"),
);
console.log(`\nVendored ${manifest.files.length} files -> ${dstDir} (${why}; apex ${commit})`);
