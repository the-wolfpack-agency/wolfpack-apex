/* FIRST. Imports hoist, so anything below already read process.env. */
import "./load-env";

/**
 * Ask every capability we claim whether it has ever actually done it.
 *
 *   npm run capabilities
 *
 * WHY ON A TIMER. Four capabilities were built, tested, configured in
 * production and had never run once: OCR, query expansion, the document
 * repair, and the retrieval eval. Every one was found by accident, weeks late,
 * while chasing something else. None of them failed loudly, because a
 * capability nothing exercises does not degrade. It simply never was.
 *
 * A check that waits for somebody to remember it is a check that does not
 * happen, which is the same lesson the repair sweep taught, so the answer is
 * the same: put it on a timer and let it report.
 *
 * EXITS NON-ZERO ONLY ON "NEVER". A stale capability is worth seeing and not
 * worth waking somebody for. An unreadable one fails the check that reads it,
 * not the product, and says so separately: a broken probe must never be
 * reported as a broken feature.
 */

import { readCapabilities } from "@/lib/capabilities/evidence";
import { describe as line, isFailing } from "@/lib/capabilities/register";

async function main(): Promise<void> {
  const statuses = await readCapabilities();

  console.log(`\n=== what we claim, and what has done it ===\n`);
  for (const s of statuses) console.log(line(s) + "\n");

  const never = statuses.filter(isFailing);
  const unknown = statuses.filter((s) => s.verdict === "unknown");
  const stale = statuses.filter((s) => s.verdict === "stale");

  console.log(
    `${statuses.length - never.length - unknown.length} demonstrated, ` +
      `${stale.length} stale, ${unknown.length} unreadable, ${never.length} never run.`,
  );

  if (unknown.length > 0) {
    /* Said separately and loudly, because a probe that cannot read its own
       evidence is a hole in the check rather than a verdict about the
       product, and conflating them is how a register stops being trusted. */
    console.error(
      `\nCould not check: ${unknown.map((s) => s.capability.id).join(", ")}. ` +
        `That is a broken probe, not a broken capability, and it needs fixing before ` +
        `this register means anything.`,
    );
  }

  if (never.length > 0) {
    console.error(`\nNever run:`);
    for (const s of never) console.error(`  ${s.capability.id}: ${s.capability.matters}`);
    console.error(
      `\nEach of these is code we built, tested and pay for, that has never once done ` +
        `its job on real data. Either exercise it or stop claiming it.`,
    );
    process.exit(1);
  }

  console.log("\nEvery capability on the register has done its job on real data.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
