/**
 * Regenerate or check the duplicate-export baseline.
 *   npm run scan:dup-exports -- --write   # accept the current set as the baseline
 *   npm run scan:dup-exports              # check; exit 1 on any new collision
 * The jest guardrail enforces this in the gate; --write is how you deliberately
 * accept a new collision (after confirming it is not a re-implementation).
 */
import { writeFileSync } from "node:fs";
import { currentCollisions, loadBaseline, BASELINE_PATH } from "../src/lib/dev/scan-duplicate-exports";

const collisions = currentCollisions();
if (process.argv.includes("--write")) {
  writeFileSync(BASELINE_PATH, JSON.stringify(collisions, null, 2) + "\n");
  console.log(`wrote ${Object.keys(collisions).length} baselined collisions`);
} else {
  const baseline = loadBaseline();
  const drift = Object.entries(collisions)
    .filter(([n, files]) => !(n in baseline) || files.some((f) => !baseline[n].includes(f)))
    .map(([n]) => n);
  if (drift.length) {
    console.error(`NEW duplicate exports (reuse the existing one, or --write to accept):\n  ${drift.join("\n  ")}`);
    process.exit(1);
  }
  console.log("no new duplicate exports");
}
