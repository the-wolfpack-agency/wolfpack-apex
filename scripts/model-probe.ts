/**
 * Ask every configured model whether it actually answers.
 *
 *   npm run models:probe
 *
 * The companion to `npm run router:exercise`. That one proves the router picks
 * correctly and costs nothing, because it never calls a model. This one proves
 * the models it picks are really there, which cannot be established without
 * calling them.
 *
 * Run it after a deployment, after a key rotation, and before a client demo.
 * Exits non-zero when a model the availability list shows as ready did not
 * answer, so CI or a cron can gate on it.
 */
import { probeAllModels } from "@/lib/ai/models/probe";

async function main(): Promise<void> {
  const report = await probeAllModels();

  console.log("\n=== model reachability ===\n");

  for (const r of report.results) {
    const label =
      r.outcome === "reachable" ? "ok  " : r.outcome === "not-configured" ? "----" : "FAIL";
    const latency = r.latencyMs === null ? "" : ` ${r.latencyMs}ms`;
    const status = r.status === null ? "" : ` HTTP ${r.status}`;
    console.log(`  [${label}] ${r.modelId.padEnd(22)}${status}${latency}`);
    if (r.detail) console.log(`         ${r.detail}`);
  }

  console.log(`\n${report.headline}\n`);

  // Non-zero only on configured-and-not-answering. A model nobody configured is
  // not a failure, and failing on it would train everyone to ignore the exit
  // code of the one check that catches a real broken deployment.
  if (report.brokenlyConfigured.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
