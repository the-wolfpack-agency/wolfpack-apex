/**
 * scripts/dogfood.ts - LOCAL factory dogfood run (the R&D engine).
 *
 * Drives the REAL factory pipeline against a task, locally, from the library
 * primitives - NO HTTP, so the Forcefield bot-guard is moot, and NO hand-coding:
 * the model authors, the deterministic gate + Stage-2 repair rule, exactly as the
 * live route runs them. One implementation reused (getAIClient / authorDiff /
 * runPipeline / runCodeReview / liveRepairComplete), zero duplication of the
 * orchestration.
 *
 * This is the fix for the rep-waste: every run here is a real R&D datapoint that
 * exercises the product instead of a hand-made change that benefits nothing. It is
 * also the core of the Model Fitness Test (plug in a model, see what a workflow PR
 * looks like + where it fails).
 *
 * Usage:
 *   npx tsx scripts/dogfood.ts "Add a `info` token to the NEON object in neon.ts"
 *   npx tsx scripts/dogfood.ts --emit "..."   # ALSO persist the run signal (feeds grading)
 *
 * --emit is OFF by default. WITHOUT it, DATABASE_URL is not even loaded, so the
 * run writes NOTHING to any database (recordReview's best-effort write no-ops).
 * WITH it, the ai_code.pipeline_run signal is persisted so the run feeds the
 * limitation profile + the router (the flywheel).
 */
import fs from "fs";
import path from "path";

const EMIT = process.argv.includes("--emit");

/** Load .env.local into process.env (no dotenv dep). Under a proof run (no
 *  --emit) we deliberately SKIP the DB url keys so nothing can be written. */
(function loadEnv() {
  const p = path.resolve(__dirname, "..", ".env.local");
  if (!fs.existsSync(p)) return;
  const DB_KEYS = new Set(["DATABASE_URL", "DATABASE_URL_UNPOOLED"]);
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    if (!EMIT && DB_KEYS.has(key)) continue; // proof run: no DB, no writes
    if (!process.env[key]) process.env[key] = m[2].replace(/^["']|["']$/g, "").trim();
  }
})();

// NB: these libs read process.env at CALL time (getAIClient()/buildRegistry run
// inside main(), after loadEnv above), so the env is in place when they execute.
import { getAIClient } from "../src/lib/ai";
import { authorDiff } from "../src/lib/ai-code/author";
import { runCodeReview } from "../src/lib/ai-code/scan";
import { runPipeline } from "../src/lib/ai-code/pipeline";
import { liveRepairComplete } from "../src/lib/ai-code/repair";

async function main(): Promise<void> {
  const prompt = process.argv.slice(2).filter((a) => !a.startsWith("--")).join(" ").trim();
  if (!prompt) {
    console.error('usage: npx tsx scripts/dogfood.ts [--emit] "<task>"');
    process.exit(2);
  }

  const nowIso = new Date().toISOString();
  const ref = `dogfood-${nowIso.replace(/[^0-9]/g, "").slice(0, 14)}`;
  const workspaceId = process.env.FACTORY_SERVICE_WORKSPACE || "dogfood";

  console.log(`\n[dogfood] task: "${prompt}"`);
  console.log(`[dogfood] emit: ${EMIT ? "ON (run signal will persist)" : "off (zero DB writes)"}\n`);

  const client = getAIClient();

  // 1. AUTHOR - the configured model produces the change.
  const authored = await authorDiff(
    { prompt, feature: "dogfood", tier: "standard" },
    { complete: (r) => client.complete(r) },
  );
  console.log(`[dogfood] authored by: ${authored.author || "(none)"}  ` +
    `cost=$${authored.costUsd ?? "?"} latency=${authored.latencyMs ?? "?"}ms`);
  if (authored.error) console.log(`[dogfood] author error: ${authored.error}`);
  if (!authored.diff.trim()) {
    console.log("[dogfood] no diff produced; the gate would reject. (honest: the model gave nothing usable)");
    return;
  }

  // 2. GATE + Stage-2 REPAIR - the exact deterministic pipeline the route runs.
  const run = await runPipeline({
    ref,
    prompt,
    diff: authored.diff,
    author: authored.author,
    nowIso,
    review: (d) => runCodeReview({ workspaceId, ref, author: authored.author, diff: d, nowIso }),
    repair: liveRepairComplete(),
  });

  console.log(`\n===== DIFF =====\n${run.diff.slice(0, 4000)}${run.diff.length > 4000 ? "\n... (truncated)" : ""}\n`);
  console.log("===== VERDICT =====");
  console.log(`status:    ${run.status}`);
  console.log(`gate:      ${run.review.verdict.outcome} (highest severity: ${run.review.verdict.highestSeverity ?? "none"})`);
  console.log(`findings:  ${run.review.findings.length}`);
  console.log(`attempts:  ${run.remediation.attempts.length}`);
  console.log(`conforms:  ${run.conformance.conforms}`);
  console.log(`open Qs:   ${run.openQuestions.length}`);

  if (EMIT) {
    console.log("\n[dogfood] --emit: run-signal persistence is wired in the next iteration (after DB confirm).");
  } else {
    console.log("\n[dogfood] proof run complete; nothing written to any database.");
  }
}

main().catch((e) => {
  console.error("[dogfood] failed:", e);
  process.exit(1);
});
