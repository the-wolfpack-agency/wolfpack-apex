/**
 * Ask the pipeline how it is, print it, and fail only when it is serious.
 *
 * Run by .github/workflows/brain-health-sweep.yml on a schedule. Lives in a
 * script rather than inline in the workflow so the decision of what counts as
 * a failure is somewhere it can be read and argued with, instead of buried in
 * an embedded heredoc.
 *
 *   node scripts/brain-health-sweep.mjs
 *
 * Needs PROD_URL and CRON_SECRET. Exits 0 with a warning when either is
 * missing: a red job that means "nobody configured this" trains people to
 * ignore red jobs.
 */

const BASE = (process.env.PROD_URL ?? "").replace(/\/$/, "");
const SECRET = process.env.CRON_SECRET ?? "";

if (!BASE || !SECRET) {
  console.log("::warning::PROD_URL or CRON_SECRET not set. Sweep SKIPPED.");
  process.exit(0);
}

const res = await fetch(`${BASE}/api/admin/brain/health`, {
  headers: { Authorization: `Bearer ${SECRET}` },
  signal: AbortSignal.timeout(60_000),
}).catch((err) => {
  console.log(`::error::Could not reach the health endpoint: ${err?.message ?? err}`);
  return null;
});

if (!res || !res.ok) {
  console.log(`::error::Health endpoint returned ${res ? res.status : "nothing"}. An unreachable pipeline is not a healthy one.`);
  process.exit(1);
}

const health = await res.json().catch(() => null);

/* AN UNREADABLE PIPELINE IS NOT A HEALTHY ONE. An empty findings list from a
   dead database looks exactly like a clean bill of health, which is the
   mistake this whole sweep exists to catch. */
if (!health || health.readable !== true) {
  console.log("::error::The pipeline could not be read, so its health is unknown. That is not the same as healthy.");
  process.exit(1);
}

const findings = Array.isArray(health.findings) ? health.findings : [];
console.log(health.summary ?? "");
console.log();
for (const f of findings) {
  console.log(`[${String(f.severity).toUpperCase()}] ${f.title}`);
  console.log(`    ${f.detail}`);
  if (f.action) console.log(`    -> ${f.action}`);
}

const serious = findings.filter((f) => f.severity === "high");
for (const f of serious) console.log(`::error::${f.title}. ${f.action ?? ""}`);
for (const f of findings.filter((f) => f.severity === "medium")) {
  console.log(`::warning::${f.title}`);
}

/* ONLY HIGH FAILS THE JOB. A sweep that goes red on every low note is a sweep
   people mute, and a muted control is what this entire month was about. */
process.exit(serious.length > 0 ? 1 : 0);
