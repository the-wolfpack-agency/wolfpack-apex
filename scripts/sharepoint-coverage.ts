/* FIRST. Imports hoist, so anything below already read process.env. */
import "./load-env";

/**
 * What we are connected to in SharePoint, and what that leaves out.
 *
 * Reads the database only, so it runs anywhere DATABASE_URL does and needs no
 * Microsoft credentials. Exits non-zero when a source cannot contribute or has
 * stopped syncing; a narrow connection is reported and never failed on, since
 * connecting one folder can be a deliberate choice.
 *
 *   npm run coverage:sharepoint
 */

import { Client } from "pg";
import { readCoverage, describeCoverage } from "@/lib/connectors/sharepoint/coverage";

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error("[coverage] DATABASE_URL is not set, so there is nothing to read.");
    process.exit(2);
  }
  const local = /@(localhost|127\.0\.0\.1)\b/.test(process.env.DATABASE_URL);
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: local ? false : { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    const { ok, lines } = describeCoverage(await readCoverage(client, process.env.INSTINCT_WORKSPACE_ID || "default"));
    for (const l of lines) console.log(`[coverage] ${l}`);
    if (!ok) {
      console.error("\n[coverage] Some sources cannot contribute or have stopped syncing.");
      process.exit(1);
    }
    console.log("\n[coverage] Every source is active and syncing.");
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  const e = err as Error & { code?: string };
  console.error("[coverage] failed:", e.message || "(no message)", e.code ?? "");
  process.exit(1);
});
