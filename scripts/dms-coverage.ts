/**
 * How much of a dealer system we can actually read, per vendor.
 *
 * Our client's dealers run at least three different dealer management
 * systems. This prints what each one supplies against the canonical record, so
 * "how much adjustment does the next system need" is answered with a number
 * before anybody commits to a date.
 *
 *   npm run dms:coverage
 */
import "./load-env";

import { readCoverage, coverageFor, CANONICAL_FIELDS } from "@/lib/dms/vendor-coverage";

function main() {
  const rows = readCoverage();
  console.log(`Canonical inventory record: ${CANONICAL_FIELDS.join(", ")}\n`);

  for (const r of rows) {
    const bar = `${r.provided}/${r.total}`;
    console.log(`  ${r.label.padEnd(22)} ${bar.padStart(5)}  ${r.access}`);
    if (r.missing.length > 0 && r.missing.length < CANONICAL_FIELDS.length) {
      console.log(`      missing: ${r.missing.join(", ")}`);
    }
  }

  const mapped = rows.filter((r) => r.access !== "not-mapped");
  console.log(
    `\n${mapped.length} of ${rows.length} systems mapped.` +
      ` Each unmapped one is field mapping plus credentials, not a rebuild:` +
      ` the driver abstraction and the widget are already shared.`,
  );

  /* THE CAVEAT THAT MATTERS MORE THAN THE NUMBERS. Full coverage of eight
     listing fields is not coverage of a dealer system. */
  const auto = coverageFor("wolfpack-auto");
  if (auto) console.log(`\n${auto.label}: ${auto.note}`);
  console.log(
    `\nThe canonical record describes a website listing, because the only implemented` +
      `\nvendor is one. Which further fields a dealer needs, such as days on the lot,` +
      `\ncost, stock number or in-transit status, is a question for the dealers rather` +
      `\nthan something to guess before mapping the first real system.`,
  );
}

main();
