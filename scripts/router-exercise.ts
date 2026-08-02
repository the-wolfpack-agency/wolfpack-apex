/**
 * Prove the model router switches, against a REAL environment.
 *
 *   npm run router:exercise
 *
 * Reads whatever models are actually configured, runs the router through every
 * decision it can make, and reports what happened. Exits non-zero when the
 * router misbehaved OR when the environment could not prove switching — because
 * "all scenarios passed with one model configured" is not a result worth
 * shipping on, and an exit code of 0 would say it was.
 *
 * Read-only. It selects models; it never calls one, so running it costs
 * nothing and touches no vendor.
 */
import { runExercise, missingConfigForSwitching } from "@/lib/ai/models/exercise";

function main(): void {
  const report = runExercise();

  console.log("\n=== model router exercise ===\n");

  console.log(`configured models: ${report.availableModels.length}`);
  for (const m of report.availableModels) {
    console.log(`  - ${m.id.padEnd(20)} ${m.tier.padEnd(10)} ${m.provider}`);
  }

  console.log("\nscenarios:\n");
  for (const r of report.results) {
    const status = r.problem ? "FAIL" : "ok  ";
    const cost = r.estimatedCostUsd === null ? "" : `  ~$${r.estimatedCostUsd.toFixed(5)}`;
    console.log(`  [${status}] ${r.scenario.padEnd(22)} -> ${r.modelId.padEnd(20)} (${r.reason})${cost}`);
    console.log(`         ${r.intent}`);
    if (r.fallbackFrom) console.log(`         degraded from: ${r.fallbackFrom}`);
    if (r.problem) console.log(`         PROBLEM: ${r.problem}`);
  }

  console.log(`\nmodels actually selected: ${report.modelsUsed.join(", ") || "(none)"}`);
  console.log(`switching proven: ${report.switchingProven ? "YES" : "NO"}`);
  console.log(`\n${report.headline}\n`);

  const steps = missingConfigForSwitching();
  if (steps.length > 0) {
    console.log("to prove switching, configure:");
    for (const s of steps) console.log(`  - ${s}`);
    console.log("");
  }

  // Non-zero on an unproven environment as well as on a real problem. A green
  // exit from a single-model environment would be read as "the router works".
  if (report.problems.length > 0 || !report.switchingProven) process.exit(1);
}

main();
