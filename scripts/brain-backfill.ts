/**
 * Embed the Brain's backlog. Thin wrapper; the logic and its tests live in
 * src/lib/brain/backfill.ts.
 *
 *   npx tsx scripts/brain-backfill.ts --dry-run
 *   npx tsx scripts/brain-backfill.ts --limit 200
 *   npx tsx scripts/brain-backfill.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });

async function main() {
  const argv = process.argv.slice(2);
  const flag = (name: string) => argv.includes(name);
  const value = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : undefined;
  };

  const { backfillEmbeddings } = await import("../src/lib/brain/backfill");
  const dryRun = flag("--dry-run");

  const started = Date.now();
  const result = await backfillEmbeddings({
    dryRun,
    limit: value("--limit"),
    batchSize: value("--batch") ?? 32,
    pauseMs: value("--pause") ?? 1_200,
    onProgress: (done, total) => {
      const pct = total > 0 ? Math.round((done / total) * 100) : 100;
      process.stdout.write(`\r  ${done}/${total} chunks (${pct}%)   `);
    },
  });
  process.stdout.write("\n");

  console.log(`backend        ${result.backend}`);
  console.log(`${dryRun ? "would embed  " : "embedded     "}  ${result.embedded}`);
  console.log(`still waiting   ${result.remaining}`);
  if (result.failedBatches > 0) {
    console.log(`failed batches  ${result.failedBatches} (rows left unembedded, safe to re-run)`);
    console.log(`reason          ${result.lastError ?? "not recorded"}`);
  }
  console.log(`took            ${((Date.now() - started) / 1000).toFixed(1)}s`);

  /* A backfill that leaves work behind has not finished, and saying "done"
     would be the same lie the silent skip told for a year. */
  if (!dryRun && result.remaining > 0) {
    console.log("\nNot finished. Run it again; it resumes where it stopped.");
    process.exit(1);
  }
  process.exit(0);
}
void main();
