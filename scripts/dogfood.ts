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
import { deepScanChange } from "../src/lib/ai-code/deep-scan";
// The SANDBOX reads with the exact PROD readers, so the prod code path is proven
// locally: records are PipelineRunRecord-shaped, graded by the one gradeRuns, and
// scored by the one modelValueScores. Promotion to prod swaps only the sink.
import { gradeRuns, type PipelineRunRecord } from "../src/lib/ai-code/grading";
import { modelValueScores } from "../src/lib/ai-code/model-benchmark";

/** Append-only local event log (gitignored). The R&D-phase stand-in for the prod
 *  analytics_events `ai_code.pipeline_run` stream - identical record shape. */
const SANDBOX = path.join(REPO_ROOT, ".dogfood", "runs.jsonl");

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

interface RunCtx {
  repoTree: Set<string>;
  aliasMap: Record<string, string>;
  installedRoots: Set<string>;
  fetchModules: (paths: readonly string[]) => Promise<Map<string, string | null>>;
  client: ReturnType<typeof getAIClient>;
  workspaceId: string;
}

interface RunResult {
  author: string;
  costUsd: number | null;
  security: string; // allow | escalate | block
  brokenImports: string[]; // "<spec> (<kind>[-> hint])"
  missingAuth: number;
  phantomImports: number;
  incompleteFiles: number;
  syntaxOk: boolean;
  /** Deep static engine (platform-scan via deepScanChange) - the SAME layer the route runs. */
  deepCritical: number;
  deepHigh: number;
  deepFindings: string[];
  handoff: boolean;
  diff: string;
  /** The PROD-shaped run record (so gradeRuns/the profile run unchanged on it). */
  record: PipelineRunRecord;
}

/** One real factory run: author -> the full shared deterministic bundle ->
 *  security gate + repair. Returns the structured verdict. */
async function runOnce(prompt: string, ctx: RunCtx): Promise<RunResult> {
  const nowIso = new Date().toISOString();
  const ref = `dogfood-${nowIso.replace(/[^0-9]/g, "").slice(0, 14)}`;
  const authored = await authorFileChanges(
    { prompt, feature: "dogfood", tier: "standard" },
    { complete: (r) => ctx.client.complete(r) },
  );
  const files = authored.changes;
  if (files.length === 0) {
    const record: PipelineRunRecord = {
      model: authored.author, status: "needs_human", attempts: 0, finalOutcome: "block",
      costUsd: authored.costUsd ?? 0, ts: Date.parse(nowIso),
    };
    return { author: authored.author, costUsd: authored.costUsd, security: "n/a", brokenImports: [], missingAuth: 0, phantomImports: 0, incompleteFiles: 0, syntaxOk: false, deepCritical: 0, deepHigh: 0, deepFindings: [], handoff: false, diff: "", record };
  }
  const diff = filesToDiff(files);
  const broken = await checkLocalImports(files, { repoTree: ctx.repoTree, aliasMap: ctx.aliasMap }, ctx.fetchModules);
  const missingAuth = findMissingAuth(files);
  const syntax = checkSyntax(files);
  const phantomImports = findPhantomImports(files, ctx.installedRoots);
  const incompleteFiles = findIncompleteFiles(files);
  // The DEEP static engine (platform-scan) - the same layer the route runs, which
  // the harness previously skipped. DRY by design: scans the authored content, no
  // checkout/network.
  const deep = await deepScanChange(diff, "local/dogfood", files);
  const run = await runPipeline({
    ref, prompt, diff, author: authored.author, nowIso,
    review: (d) => runCodeReview({ workspaceId: ctx.workspaceId, ref, author: authored.author, diff: d, nowIso }),
    repair: liveRepairComplete(),
  });
  const handoff = run.status === "ready_for_pr" && broken.length === 0 && missingAuth.length === 0 &&
    phantomImports.length === 0 && incompleteFiles.length === 0 && syntax.ok &&
    !deep.blocking && deep.critical === 0;
  // PROD-shaped record. status reflects the FAITHFUL handoff (holds on any gate),
  // deepScanCritical folds in missing-auth exactly as the route does.
  const record: PipelineRunRecord = {
    model: authored.author,
    status: handoff ? "ready_for_pr" : "needs_human",
    attempts: run.remediation.attempts.length,
    finalOutcome: run.review.verdict.outcome,
    deepScanCritical: deep.critical + missingAuth.length,
    selfHealed: run.remediation.attempts.length > 0 && handoff,
    costUsd: authored.costUsd ?? 0,
    phantomImports: phantomImports.length,
    brokenLocalImports: broken.length,
    incompleteFiles: incompleteFiles.length,
    removedExports: 0, // no base-content fetch locally
    anchorFailures: 0,
    ts: Date.parse(nowIso),
  };
  return {
    author: authored.author,
    costUsd: authored.costUsd,
    security: run.review.verdict.outcome,
    brokenImports: broken.map((b) => `${b.spec} (${b.kind}${b.hint ? ` -> ${b.hint}` : ""})`),
    missingAuth: missingAuth.length,
    phantomImports: phantomImports.length,
    incompleteFiles: incompleteFiles.length,
    syntaxOk: syntax.ok,
    deepCritical: deep.critical,
    deepHigh: deep.high,
    deepFindings: deep.findings.map((f) => `${f.title} [${f.category}/${f.severity}]`),
    handoff,
    diff,
    record,
  };
}

/** Append a run record to the local sandbox log (gitignored). */
function emitRecord(r: PipelineRunRecord): void {
  fs.mkdirSync(path.dirname(SANDBOX), { recursive: true });
  fs.appendFileSync(SANDBOX, JSON.stringify(r) + "\n");
}

/** --profile: read the sandbox log and run the EXACT prod readers over it -
 *  gradeRuns -> per-model grade + failure profile, and modelValueScores -> the
 *  router's value map. Proves the whole flywheel locally, zero DB. */
function printProfile(): void {
  if (!fs.existsSync(SANDBOX)) { console.log(`[dogfood] no sandbox log yet (${path.relative(REPO_ROOT, SANDBOX)}). Run with --emit first.`); return; }
  const records: PipelineRunRecord[] = fs.readFileSync(SANDBOX, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const grade = gradeRuns(records);
  const values = modelValueScores(grade.byModel);
  console.log(`\n===== MODEL PROFILE (from ${records.length} sandbox runs) =====`);
  for (const m of grade.byModel) {
    const fp = m.failureProfile;
    const fails = Object.entries(fp).filter(([, v]) => v > 0).map(([k, v]) => `${k}=${Math.round(v * 100)}%`).join(" ") || "none";
    console.log(`\n${m.model}  (n=${m.n})`);
    console.log(`  readyRate=${Math.round(m.readyRate * 100)}%  firstPass=${Math.round(m.firstPassRate * 100)}%  blockRate=${Math.round(m.blockRate * 100)}%  avgCost=$${m.avgCostUsd.toFixed(4)}`);
    console.log(`  failure profile: ${fails}`);
    console.log(`  router value score: ${values[m.model] !== undefined ? values[m.model].toFixed(2) : "(unscored: too few runs or unpriced)"}`);
  }
  console.log("");
}

function buildCtx(): RunCtx {
  const repoTree = buildRepoTree();
  return {
    repoTree,
    aliasMap: parseAliasMap(readRepoFile("tsconfig.json") ?? "{}"),
    installedRoots: parseInstalledRoots(readRepoFile("package.json") ?? "{}"),
    fetchModules: async (paths) => new Map(paths.map((p) => [p, readRepoFile(p)] as const)),
    client: getAIClient(),
    workspaceId: process.env.FACTORY_SERVICE_WORKSPACE || "dogfood",
  };
}

async function main(): Promise<void> {
  // --profile: just read the sandbox + print the flywheel (no run, no model call).
  if (process.argv.includes("--profile")) { printProfile(); return; }

  const repeatArg = process.argv.find((a) => a.startsWith("--repeat"));
  const repeat = repeatArg ? Math.max(1, parseInt(repeatArg.split("=")[1] ?? "1", 10) || 1) : 1;
  const prompt = process.argv.slice(2).filter((a) => !a.startsWith("--")).join(" ").trim();
  if (!prompt) { console.error('usage: npx tsx scripts/dogfood.ts [--emit] [--repeat=N] "<task>"  |  --profile'); process.exit(2); }

  console.log(`\n[dogfood] task: "${prompt}"`);
  console.log(`[dogfood] emit: ${EMIT ? "ON" : "off (zero DB writes)"}  repeat: ${repeat}\n`);
  const ctx = buildCtx();

  // SINGLE RUN - detailed verdict.
  if (repeat === 1) {
    const r = await runOnce(prompt, ctx);
    console.log(`[dogfood] authored by: ${r.author || "(none)"}  cost=$${r.costUsd ?? "?"}`);
    if (!r.diff) { console.log("[dogfood] no files produced; the gate would reject."); return; }
    console.log(`\n===== DIFF =====\n${r.diff.slice(0, 3500)}${r.diff.length > 3500 ? "\n... (truncated)" : ""}\n`);
    console.log("===== VERDICT =====");
    console.log(`security gate:     ${r.security}`);
    console.log(`broken imports:    ${r.brokenImports.length}${r.brokenImports.length ? "  <-- " + r.brokenImports.join(", ") : ""}`);
    console.log(`missing auth:      ${r.missingAuth}`);
    console.log(`phantom imports:   ${r.phantomImports}`);
    console.log(`incomplete files:  ${r.incompleteFiles}`);
    console.log(`syntax ok:         ${r.syntaxOk}`);
    console.log(`deep scan:         crit=${r.deepCritical} high=${r.deepHigh}${r.deepFindings.length ? "  <-- " + r.deepFindings.join(", ") : ""}`);
    console.log(`\nHANDOFF:           ${r.handoff ? "ready_for_pr" : "needs_human (a gate held)"}`);
    if (EMIT) { emitRecord(r.record); console.log(`\n[dogfood] --emit: appended 1 run to ${path.relative(REPO_ROOT, SANDBOX)} (read it with --profile).`); }
    else console.log("\n[dogfood] proof run; nothing persisted.");
    return;
  }

  // REPEAT - measure the BEHAVIORAL ENVELOPE: the same task N times reveals the
  // variance around the ideal path (the std-dev the barriers are sized to).
  const results: RunResult[] = [];
  for (let i = 0; i < repeat; i++) {
    process.stdout.write(`[dogfood] run ${i + 1}/${repeat}... `);
    const r = await runOnce(prompt, ctx);
    results.push(r);
    if (EMIT) emitRecord(r.record);
    console.log(`${r.handoff ? "ready_for_pr" : "needs_human"}  (imports:${r.brokenImports.length} auth:${r.missingAuth} phantom:${r.phantomImports} incomplete:${r.incompleteFiles})`);
  }
  const rate = (n: number) => `${Math.round((n / repeat) * 100)}%`;
  const fired = (pred: (r: RunResult) => boolean) => results.filter(pred).length;
  const handoffs = fired((r) => r.handoff);
  const allSpecs = new Set(results.flatMap((r) => r.brokenImports));
  const totalCost = results.reduce((s, r) => s + (r.costUsd ?? 0), 0);

  console.log(`\n===== BEHAVIORAL ENVELOPE (${repeat} runs of the SAME task) =====`);
  console.log(`author:            ${results[0].author}`);
  console.log(`HANDOFF (ideal):   ${handoffs}/${repeat} ready_for_pr  (${rate(handoffs)})`);
  console.log(`held by a gate:    ${repeat - handoffs}/${repeat}`);
  console.log(`-- deviation (how often each gate had to hold the output) --`);
  console.log(`broken imports:    ${rate(fired((r) => r.brokenImports.length > 0))} of runs  (avg ${(results.reduce((s, r) => s + r.brokenImports.length, 0) / repeat).toFixed(1)}/run)`);
  console.log(`missing auth:      ${rate(fired((r) => r.missingAuth > 0))} of runs`);
  console.log(`phantom imports:   ${rate(fired((r) => r.phantomImports > 0))} of runs`);
  console.log(`incomplete files:  ${rate(fired((r) => r.incompleteFiles > 0))} of runs`);
  console.log(`security != allow: ${rate(fired((r) => r.security !== "allow" && r.security !== "n/a"))} of runs`);
  if (allSpecs.size > 0) {
    console.log(`-- distinct hallucinated/broken imports across runs (${allSpecs.size}) --`);
    for (const s of allSpecs) console.log(`  ${s}`);
  }
  console.log(`\ntotal cost: $${totalCost.toFixed(4)} over ${repeat} runs`);
  console.log(EMIT
    ? `[dogfood] --emit: appended ${repeat} runs to ${path.relative(REPO_ROOT, SANDBOX)} (read the flywheel with --profile).`
    : "[dogfood] envelope complete; nothing persisted.");
}

main().catch((e) => { console.error("[dogfood] failed:", e); process.exit(1); });
