/**
 * Does a gist that keeps no private data still predict a bad outcome?
 *
 * The experiment that has to come before the graph. Reads real conversations,
 * reduces each turn to a fixed-vocabulary gist, and reports which gist
 * features predict that the turn ended badly.
 *
 *   npx tsx scripts/gist-signal.ts [days]
 *
 * Reads only. Writes nothing, stores nothing, and prints no message text.
 */

import { extractGists } from "@/lib/gist/extract";
import { measureSignal, MIN_OBSERVATIONS } from "@/lib/gist/signal";

(async () => {
  const days = Number(process.argv[2] ?? 90);
  const gists = await extractGists(days);
  const report = measureSignal(gists);

  console.log(`\n${report.turns} answered turns over ${days} days`);
  console.log(`base rate of a bad ending: ${(report.baseBadRate * 100).toFixed(1)}%`);
  console.log(`(bad = the person hit a dead end, or asked the same thing again)\n`);

  const outcomes = new Map<string, number>();
  for (const g of gists) outcomes.set(g.outcome, (outcomes.get(g.outcome) ?? 0) + 1);
  console.log("outcomes:");
  for (const [k, v] of [...outcomes].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(14)} ${String(v).padStart(6)}  ${((v / report.turns) * 100).toFixed(1)}%`);
  }

  console.log(`\nfeature values, worst first (floor ${MIN_OBSERVATIONS} observations):`);
  for (const s of report.signals) {
    const flag = !s.trustworthy ? "too few" : s.lift >= 1.5 ? "PREDICTS" : s.lift <= 0.5 ? "protects" : "";
    console.log(
      `  ${(s.feature + "=" + s.value).padEnd(26)} n=${String(s.observations).padStart(6)}  bad=${(s.badRate * 100).toFixed(1).padStart(5)}%  lift=${s.lift.toFixed(2).padStart(5)}  ${flag}`,
    );
  }

  console.log(
    `\n${report.usable.length} feature value(s) both clear the floor and move the rate enough to act on.`,
  );
  if (report.usable.length === 0) {
    console.log("The gist does NOT carry usable signal on this data. The graph would store noise.");
  } else {
    console.log("The gist carries signal. Storing it is worth doing.");
  }
  process.exit(0);
})().catch((err) => {
  console.error("failed:", (err as Error).message.slice(0, 200));
  process.exit(1);
});
