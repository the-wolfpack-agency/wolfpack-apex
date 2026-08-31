/**
 * Run the integrations that were built and never used.
 *
 * Twelve of eighteen Microsoft surfaces had ever run in production. The six
 * that had not were not broken: they sit behind features nobody here uses
 * daily, so no event was written, and a surface with no events looks exactly
 * like a broken one.
 *
 * Every call is a read. Nothing is created, written or changed.
 *
 * Usage:
 *   npx tsx scripts/exercise-integrations.ts --user someone@example.com
 *
 * Then `npm run integrations:evidence` to see the count move.
 */
import "./load-env";

import { exerciseUnprovenSurfaces } from "@/lib/health/unproven-surfaces";

async function main() {
  const i = process.argv.indexOf("--user");
  const userId = i > -1 ? process.argv[i + 1] : process.env.MS_PROBE_USER;
  if (!userId) {
    console.error(
      "usage: npx tsx scripts/exercise-integrations.ts --user <email>\n\n" +
        "The surfaces read that person's own Microsoft data with their stored token.\n" +
        "Nothing is written.",
    );
    process.exit(2);
  }
  const workspaceId = process.env.WORKSPACE_ID ?? "default";

  console.log(`Exercising the unproven surfaces as ${userId}. Reads only.\n`);
  const results = await exerciseUnprovenSurfaces(workspaceId, userId);

  for (const r of results) {
    const mark = r.ok ? "ok  " : r.notConfigured ? "n/a " : "FAIL";
    const detail = r.ok
      ? JSON.stringify(r.schemaPayload ?? {})
      : (r.errorMessage ?? "").slice(0, 80);
    console.log(`  ${mark}  ${String(r.objectType ?? "?").padEnd(12)} ${String(r.durationMs).padStart(5)}ms  ${detail}`);
  }

  const ran = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok && !r.notConfigured).length;
  /* Two different reasons a surface did not run, and they need different
     people. No connection is somebody signing in; a missing scope is an
     administrator deciding. */
  const unconnected = results.filter((r) => (r.errorMessage ?? "").includes("no connected")).length;
  const needsScope = results.filter(
    (r) => r.notConfigured && (r.errorMessage ?? "").includes("administrator consent"),
  ).length;

  console.log(`\n${ran} surface(s) ran, ${failed} failed.`);
  if (unconnected > 0) {
    console.log(
      `${unconnected} could not be tried: that account has no working Microsoft connection here.\n` +
        `Refreshing a token needs MICROSOFT_CLIENT_SECRET, which is set in the deployment and\n` +
        `not on a developer machine, so this earns nothing when run locally. It runs nightly in\n` +
        `production with the other integration probes.`,
    );
  }
  if (needsScope > 0) {
    console.log(`${needsScope} need a permission this deployment does not request.`);
  }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
