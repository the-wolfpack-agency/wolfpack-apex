/**
 * Which integrations are BUILT, and which have ever actually worked.
 *
 * Eighteen Microsoft Graph surfaces exist in this repo. Before a client call
 * that is a tempting number to say out loud, and it is the wrong number: built
 * and proven are different claims, and only one of them survives a client
 * asking "can you show me".
 *
 * Measured on 2026-08-26 over ninety days of production: mail, meetings,
 * SharePoint and search active that day; Teams and calendar within the week;
 * directory, tasks, planner and groups real but stale; and files, people,
 * contacts, mailbox, OneNote, presence and project with no production
 * evidence at all. Seven of eighteen had never been exercised.
 *
 * THIS IS A REPORT, NOT A GATE. An unused surface is not a defect: nobody has
 * needed it yet. It becomes a defect the moment somebody counts it in a
 * promise, so the point is that the count is available before the promise
 * rather than after it.
 *
 *   npx tsx scripts/integration-evidence.ts
 *   npx tsx scripts/integration-evidence.ts --days 30
 *
 * The surface list is asserted against the files on disk by
 * src/lib/integrations/__tests__/integration-evidence.test.ts, so a new
 * integration cannot be silently missing from this inventory.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

/* DYNAMIC IMPORT, and it is not a style choice. A static `import` is hoisted
   above config() above, so src/lib/db would read DATABASE_URL before dotenv
   had set it, build its pool without a connection string, and fail with a TLS
   error that points at everything except the real cause. scripts/brain-eval.ts
   already does this for the same reason. */
type QueryFn = <T>(text: string, params?: unknown[]) => Promise<{ rows: T[] }>;

async function db(): Promise<QueryFn> {
  const m = await import("../src/lib/db");
  return m.query as unknown as QueryFn;
}

/* TYPE-ONLY at module scope, and that is load-bearing. The evidence module
   statically imports src/lib/db, and a value import here would be hoisted
   above config() below: the pool would be built with no connection string and
   fail with a TLS error that points at everything except the real cause. The
   values are pulled in with await import() inside main(), after dotenv has
   run. scripts/brain-eval.ts does the same, for the same reason. */
export type { Surface, Evidence } from "../src/lib/integrations/evidence";
import type { Evidence } from "../src/lib/integrations/evidence";

async function main() {
  const { SURFACES, verdict, gatherEvidence } = await import(
    "../src/lib/integrations/evidence"
  );
  const i = process.argv.indexOf("--days");
  const days = i >= 0 ? Number(process.argv[i + 1]) : 90;
  const rows = await gatherEvidence(days);

  console.log(`\nIntegration evidence, last ${days} days\n`);
  console.log("  surface              verdict     events  last seen");
  console.log("  " + "-".repeat(56));
  for (const r of rows) {
    console.log(
      `  ${r.label.padEnd(20)} ${verdict(r).padEnd(11)} ${String(r.events).padStart(6)}  ${r.lastSeen ?? "never"}`,
    );
  }

  const counts = { active: 0, stale: 0, unproven: 0 };
  for (const r of rows) counts[verdict(r)]++;
  console.log(
    `\n  ${SURFACES.length} built. ${counts.active} active, ${counts.stale} stale, ${counts.unproven} never exercised.`,
  );
  /* The sentence this script exists to make available before a client call
     rather than during one. */
  console.log(`  Say "${counts.active + counts.stale} have run in production", not "${SURFACES.length} integrations".\n`);
}

if (require.main === module) {
  main().then(
    () => process.exit(0),
    (err) => {
      console.error("[integration-evidence]", (err as Error).message);
      process.exit(1);
    },
  );
}
