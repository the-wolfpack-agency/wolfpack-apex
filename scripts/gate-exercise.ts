/**
 * Prove the bring-your-own-agent gate against a REAL running deployment.
 *
 *   npm run gate:exercise                     # against localhost
 *   GATE_URL=https://... npm run gate:exercise
 *
 * Mints a scoped key, calls the public gate endpoint over HTTP exactly as an
 * outside agent would, checks that it is authorized in scope, refused out of
 * scope, refused after revocation and refused when unknown, then revokes every
 * key it created.
 *
 * Exits non-zero when the gate misbehaved. Exits non-zero when nothing could be
 * proved, too: "no steps ran" reported as success is how a green check comes to
 * mean nothing, and this exercise exists because the external gate was fully
 * built, fully tested in isolation, and had never once been called.
 *
 * Talks to the deployed route over HTTP on purpose. Importing authorize() and
 * calling it directly would skip the parts most likely to be wrong: the bearer
 * parsing, the rate limiter, the status-code discipline that returns a policy
 * deny as 200 rather than 403.
 */

import { config } from "dotenv";

config({ path: ".env.local" });

async function main(): Promise<void> {
  /* Imported after dotenv, not at module load: a top-level import of anything
     that reads DATABASE_URL captures it before the file above is applied. */
  const { runExternalAgentExercise } = await import("@/lib/ogiam/external-agent-exercise");

  const baseUrl = (process.env.GATE_URL ?? "http://127.0.0.1:3000").replace(/\/+$/, "");
  const workspaceId = process.env.GATE_EXERCISE_WORKSPACE ?? "default";
  const createdBy = process.env.GATE_EXERCISE_ACTOR ?? "gate-exercise";

  console.log(`\n=== external agent gate exercise ===\n`);
  console.log(`gate:      ${baseUrl}/api/gate/authorize`);
  console.log(`workspace: ${workspaceId}\n`);

  const report = await runExternalAgentExercise({
    workspaceId,
    createdBy,
    callGate: async (apiKey, body) => {
      const res = await fetch(`${baseUrl}/api/gate/authorize`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });
      const parsed = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      return { status: res.status, body: parsed };
    },
  });

  for (const s of report.steps) {
    console.log(`${s.passed ? "PASS" : "FAIL"}  ${s.name}`);
    console.log(`      expected: ${s.expectation}`);
    console.log(`      observed: ${s.observed}\n`);
  }

  console.log(`keys minted and revoked: ${report.keysCleanedUp}`);

  if (report.inconclusive) {
    console.error(`\nINCONCLUSIVE: ${report.inconclusiveReason ?? "nothing could be proved"}`);
    process.exit(2);
  }
  if (!report.passed) {
    console.error(`\nFAILED: ${report.steps.filter((s) => !s.passed).length} of ${report.steps.length} steps`);
    process.exit(1);
  }
  console.log(`\nAll ${report.steps.length} steps passed against a real gate.`);
  process.exit(0);
}

main().catch((err) => {
  console.error("gate exercise could not run:", err instanceof Error ? err.message : err);
  process.exit(2);
});
