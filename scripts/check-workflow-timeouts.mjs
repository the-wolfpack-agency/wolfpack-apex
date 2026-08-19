/**
 * Every CI job must state how long it is allowed to take.
 *
 * WHY THIS EXISTS
 *
 * 2026-08-19: a PR sat "pending" for half an hour on `Install Playwright
 * browsers`, a step that normally takes two minutes. Nothing was wrong with the
 * change; the download had stalled. With no `timeout-minutes` the job would
 * have held the PR for GitHub's default of SIX HOURS before failing, burning
 * runner minutes the whole time, and the only signal to a human is a check that
 * never finishes. Eleven jobs across eleven workflows were unbounded.
 *
 * A timeout does not make CI faster. It makes a hang look like a failure, which
 * is something a person can act on, and it caps what one stuck job can cost.
 *
 * This is a fast structural check, not a lint rule: it reads the YAML as text
 * and needs no dependency. Run by `npm run ci:check-timeouts` and in verify.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = ".github/workflows";
const problems = [];

for (const file of readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f))) {
  const lines = readFileSync(join(DIR, file), "utf8").split("\n");
  let job = null;
  let sawRunsOn = false;
  let sawTimeout = false;

  const close = () => {
    if (job && sawRunsOn && !sawTimeout) problems.push(`${file}: job "${job}" has no timeout-minutes`);
  };

  for (const line of lines) {
    /* A job key is exactly two spaces in. Anything deeper belongs to the job
       body, which is why a `runs-on` inside a matrix does not start a new one. */
    const jobKey = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (jobKey) {
      close();
      job = jobKey[1];
      sawRunsOn = false;
      sawTimeout = false;
      continue;
    }
    if (!job) continue;
    if (/^\s{4}runs-on:/.test(line)) sawRunsOn = true;
    if (/^\s{4}timeout-minutes:/.test(line)) sawTimeout = true;
  }
  close();
}

if (problems.length) {
  console.error("Unbounded CI jobs (a hang would run for GitHub's 6-hour default):\n");
  for (const p of problems) console.error(`  ${p}`);
  console.error("\nAdd `timeout-minutes:` beneath runs-on. Size it to the job, generously.");
  process.exit(1);
}
console.log(`[timeouts] every CI job in ${DIR} states a timeout.`);
