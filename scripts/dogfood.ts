/**
 * scripts/dogfood.ts - LOCAL factory dogfood run (the R&D engine / Model Fitness Test core).
 *
 * Drives the REAL factory pipeline against a task, locally, from the library
 * primitives - NO HTTP (the Forcefield bot-guard is moot), NO hand-coding, and NO
 * duplication of the checks: it runs the SAME shared functions the live route runs
 * (getAIClient router -> authorFileChanges -> the deterministic check bundle ->
 * runPipeline gate + Stage-2 repair). The ONLY difference from the route is the
 * injected module fetcher: the route reads target modules from GitHub, the harness
 * reads them from disk - so checkLocalImports (and the rest) apply the identical rule.
 *
 * Every run is a real R&D datapoint that exercises the product instead of a
 * hand-made change that benefits nothing. Plug in any model, see what a workflow
 * PR looks like + exactly where it fails = the Model Fitness Test.
 *
 * Usage:
 *   npx tsx scripts/dogfood.ts "Add a route ... gated by requireCapability ..."
 *   npx tsx scripts/dogfood.ts --emit "..."   # ALSO persist the run signal (feeds grading)
 *
 * --emit is OFF by default; WITHOUT it DATABASE_URL is not even loaded, so the run
 * writes NOTHING (recordReview's best-effort write no-ops).
 */
import fs from "fs";
import path from "path";

const EMIT = process.argv.includes("--emit");
const REPO_ROOT = path.resolve(__dirname, "..");

/** Load .env.local into process.env. Proof runs (no --emit) SKIP the DB url keys
 *  so nothing can be written. */
(function loadEnv() {
  const p = path.join(REPO_ROOT, ".env.local");
  if (!fs.existsSync(p)) return;
  const DB_KEYS = new Set(["DATABASE_URL", "DATABASE_URL_UNPOOLED"]);
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    if (!EMIT && DB_KEYS.has(m[1])) continue;
    if (!process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
  }
})();

// These libs read process.env at CALL time (inside main(), after loadEnv), so the
// env is in place when they run.
import { getAIClient } from "../src/lib/ai";
import { authorFileChanges } from "../src/lib/ai-code/author";
import { runCodeReview } from "../src/lib/ai-code/scan";
import { runPipeline } from "../src/lib/ai-code/pipeline";
import { liveRepairComplete } from "../src/lib/ai-code/repair";
import { filesToDiff } from "../src/lib/ai-code/file-changes";
import {
  checkLocalImports, parseAliasMap, parseInstalledRoots, findPhantomImports,
} from "../src/lib/ai-code/imports";
import { findMissingAuth } from "../src/lib/ai-code/missing-auth";
import { checkSyntax } from "../src/lib/ai-code/syntax-check";
import { findIncompleteFiles } from "../src/lib/ai-code/completeness";

/** Build the repo tree (repo-relative paths) from disk - the local equivalent of
 *  the route's GitHub tree, so import existence is judged against the real repo. */
function buildRepoTree(): Set<string> {
  const tree = new Set<string>();
  const EXT = /\.(tsx?|jsx?|mjs|cjs|json|css|scss|svg|md|sql)$/;
  const SKIP = new Set(["node_modules", ".next", ".git", "dist", "build", "coverage"]);
  (function walk(dir: string) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (EXT.test(e.name)) tree.add(path.relative(REPO_ROOT, full));
    }
  })(path.join(REPO_ROOT, "src"));
  return tree;
}

const readRepoFile = (p: string): string | null => {
  try { return fs.readFileSync(path.join(REPO_ROOT, p), "utf8"); } catch { return null; }
};

async function main(): Promise<void> {
  const prompt = process.argv.slice(2).filter((a) => !a.startsWith("--")).join(" ").trim();
  if (!prompt) { console.error('usage: npx tsx scripts/dogfood.ts [--emit] "<task>"'); process.exit(2); }

  const nowIso = new Date().toISOString();
  const ref = `dogfood-${nowIso.replace(/[^0-9]/g, "").slice(0, 14)}`;
  const workspaceId = process.env.FACTORY_SERVICE_WORKSPACE || "dogfood";

  console.log(`\n[dogfood] task: "${prompt}"`);
  console.log(`[dogfood] emit: ${EMIT ? "ON (run signal will persist)" : "off (zero DB writes)"}\n`);

  // Local repo context (the disk equivalent of the route's GitHub-derived context).
  const repoTree = buildRepoTree();
  const aliasMap = parseAliasMap(readRepoFile("tsconfig.json") ?? "{}");
  const installedRoots = parseInstalledRoots(readRepoFile("package.json") ?? "{}");
  const fetchModules = async (paths: readonly string[]) =>
    new Map(paths.map((p) => [p, readRepoFile(p)] as const));

  const client = getAIClient();

  // 1. AUTHOR - structured full-file changes, so the checks see real file content.
  const authored = await authorFileChanges(
    { prompt, feature: "dogfood", tier: "standard" },
    { complete: (r) => client.complete(r) },
  );
  console.log(`[dogfood] authored by: ${authored.author || "(none)"}  cost=$${authored.costUsd ?? "?"} latency=${authored.latencyMs ?? "?"}ms`);
  if (authored.error) console.log(`[dogfood] author error: ${authored.error}`);
  const files = authored.changes;
  if (files.length === 0) { console.log("[dogfood] no files produced; the gate would reject."); return; }
  const diff = filesToDiff(files);

  // 2. THE DETERMINISTIC CHECK BUNDLE - the exact shared primitives the route runs,
  //    with a DISK-backed module fetcher (vs the route's GitHub fetcher).
  const [brokenLocalImports] = [await checkLocalImports(files, { repoTree, aliasMap }, fetchModules)];
  const missingAuth = findMissingAuth(files);
  const syntax = checkSyntax(files);
  const phantomImports = findPhantomImports(files, installedRoots);
  const incompleteFiles = findIncompleteFiles(files);

  // 3. SECURITY GATE + Stage-2 REPAIR (runPipeline) on the authored diff.
  const run = await runPipeline({
    ref, prompt, diff, author: authored.author, nowIso,
    review: (d) => runCodeReview({ workspaceId, ref, author: authored.author, diff: d, nowIso }),
    repair: liveRepairComplete(),
  });

  console.log(`\n===== DIFF =====\n${diff.slice(0, 3500)}${diff.length > 3500 ? "\n... (truncated)" : ""}\n`);
  console.log("===== VERDICT =====");
  console.log(`security gate:     ${run.review.verdict.outcome} (highest: ${run.review.verdict.highestSeverity ?? "none"}, findings: ${run.review.findings.length})`);
  console.log(`broken imports:    ${brokenLocalImports.length}${brokenLocalImports.length ? "  <-- " + brokenLocalImports.map((b) => `${b.spec} (${b.kind}${b.hint ? ` -> ${b.hint}` : ""})`).join(", ") : ""}`);
  console.log(`missing auth:      ${missingAuth.length}${missingAuth.length ? "  <-- " + missingAuth.map((m) => m.title).join(", ") : ""}`);
  console.log(`phantom imports:   ${phantomImports.length}`);
  console.log(`incomplete files:  ${incompleteFiles.length}`);
  console.log(`syntax ok:         ${syntax.ok}`);
  console.log(`repair attempts:   ${run.remediation.attempts.length}`);

  // The FAITHFUL handoff verdict: the route holds on ANY of these, not just the
  // security gate. This is what makes the harness a true Model Fitness Test.
  const wouldHandOff =
    run.status === "ready_for_pr" &&
    brokenLocalImports.length === 0 && missingAuth.length === 0 &&
    phantomImports.length === 0 && incompleteFiles.length === 0 && syntax.ok;
  console.log(`\nHANDOFF:           ${wouldHandOff ? "ready_for_pr" : "needs_human (a gate held)"}`);

  console.log(EMIT
    ? "\n[dogfood] --emit: run-signal persistence is the next iteration (after DB confirm)."
    : "\n[dogfood] proof run complete; nothing written to any database.");
}

main().catch((e) => { console.error("[dogfood] failed:", e); process.exit(1); });
