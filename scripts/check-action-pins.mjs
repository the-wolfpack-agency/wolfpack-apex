/**
 * Every GitHub Action must be pinned to a commit SHA, not a tag.
 *
 * A tag is mutable. Whoever controls the action can move v5 to different code
 * tomorrow, and that code runs in CI holding this repository's secrets. A
 * forty-character SHA is the only form that says which code will run.
 *
 * WHY IT LIVES HERE AS WELL AS IN CI. The hygiene workflow already enforces
 * this, and it caught a real slip on 2026-09-01: a new workflow used
 * actions/checkout@v5 and actions/setup-node@v5. But scripts/verify.sh is the
 * command this repository says to run before pushing, and it did not carry the
 * check, so a green local run was followed by a red pull request.
 *
 * A check that only exists after the push teaches people to push and find out.
 * This is the same rule as the CI job, run at the point where it is cheap to
 * act on.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const DIR = ".github/workflows";
/* owner/repo@something, where something is not a 40-hex SHA. Local actions
   (./.github/...) and docker:// references are not tag-pinned and not this
   check's business. */
const USES = /^\s*-?\s*uses:\s*([A-Za-z0-9._-]+\/[^@\s]+)@(\S+)/;
const SHA = /^[0-9a-f]{40}$/;

const offenders = [];
for (const file of readdirSync(DIR).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))) {
  const lines = readFileSync(path.join(DIR, file), "utf8").split("\n");
  lines.forEach((line, i) => {
    const m = USES.exec(line);
    if (!m) return;
    const ref = m[2].replace(/\s*#.*$/, "").trim();
    if (SHA.test(ref)) return;
    offenders.push(`${DIR}/${file}:${i + 1}  ${m[1]}@${ref}`);
  });
}

if (offenders.length > 0) {
  console.error("These actions are pinned to a tag, which whoever owns them can move:\n");
  for (const o of offenders) console.error(`  ${o}`);
  console.error(
    "\nPin each to a full commit SHA with the version in a trailing comment:" +
      "\n  uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0",
  );
  process.exit(1);
}

console.log(`All actions across ${readdirSync(DIR).length} workflow files are SHA-pinned.`);
