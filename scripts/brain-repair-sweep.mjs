/**
 * Drain the documents whose failure reason has since been fixed.
 *
 * WHY THIS RUNS ON A SCHEDULE. The repair endpoint was written for ninety Word
 * documents that failed on a parser bug fixed in #402. Measured 2026-08-27, it
 * had never been called. Not once. The fix shipped, the corpus it was written
 * for was never re-run, and every one of those documents was still unreadable
 * months later.
 *
 * A repair that waits for somebody to remember it is a repair that does not
 * happen. This is the same shape as a control declared and never executed,
 * which is the recurring failure in this codebase, so the answer is the same:
 * put it on a timer and let it report.
 *
 * Reports what it repaired and what it could not. A run that fixes nothing
 * because there is nothing to fix is a good run and exits 0. A run that cannot
 * reach the endpoint exits non-zero, because "could not look" and "nothing to
 * do" must not read alike.
 *
 * Required env: PROD_URL, CRON_SECRET. Skips cleanly when absent, because a
 * red job meaning "nobody configured this" trains people to ignore red jobs.
 */

const BASE = (process.env.PROD_URL ?? "").replace(/\/+$/, "");
const SECRET = process.env.CRON_SECRET ?? "";
/* Bounded per run. The repair re-downloads each file from the drive, so an
   unbounded sweep would be a long job hammering Graph. Whatever is left is
   picked up by tomorrow's run. */
const LIMIT = Number(process.env.REPAIR_LIMIT ?? 50);

if (!BASE || !SECRET) {
  console.log("[repair] PROD_URL or CRON_SECRET not set. Skipping.");
  process.exit(0);
}

const headers = {
  Authorization: `Bearer ${SECRET}`,
  "Content-Type": "application/json",
};

async function main() {
  /* Ask first. GET is read-only and tells us whether there is anything to do,
     so a quiet day costs one request rather than a repair run. */
  const planRes = await fetch(`${BASE}/api/admin/brain/reprocess`, { headers });
  if (!planRes.ok) {
    console.error(`[repair] could not read the repair queue: HTTP ${planRes.status}`);
    process.exit(1);
  }
  const plan = await planRes.json();

  if (plan.readable === false) {
    console.error(`[repair] the queue could not be read: ${plan.error ?? "unknown"}`);
    process.exit(1);
  }

  const waiting = Number(plan.candidates ?? 0);
  console.log(`[repair] documents waiting on a repair: ${waiting}`);
  for (const [reason, n] of Object.entries(plan.byReason ?? {})) {
    console.log(`[repair]   ${n} ${reason}`);
  }

  if (waiting === 0) {
    console.log("[repair] nothing to repair.");
    process.exit(0);
  }

  const runRes = await fetch(`${BASE}/api/admin/brain/reprocess`, {
    method: "POST",
    headers,
    body: JSON.stringify({ limit: LIMIT }),
  });
  if (!runRes.ok) {
    console.error(`[repair] the repair run failed: HTTP ${runRes.status}`);
    process.exit(1);
  }
  const result = await runRes.json();

  const repaired = Number(result.repaired ?? 0);
  const failed = Number(result.failed ?? 0);
  console.log(`[repair] repaired ${repaired}, still failing ${failed}`);

  /* Still-failing documents are NOT a job failure. Some will never extract:
     a scanned PDF with no text layer, a file type nothing can read. Reporting
     them red every night would train everyone to ignore this job, which is
     how the original ninety went unnoticed. The count is printed so it can be
     watched, and the sweep is judged on whether it could run. */
  if (repaired === 0 && failed > 0) {
    console.log("[repair] nothing repaired this run. These may need a different extractor.");
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("[repair] could not run:", err instanceof Error ? err.message : err);
  process.exit(1);
});
