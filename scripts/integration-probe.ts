/**
 * Do the quiet integrations WORK, or is nobody calling them?
 *
 * integration-evidence.ts says which surfaces have produced events. It cannot
 * say why a surface is silent, and the two reasons are opposite: a surface
 * nobody has needed is fine and needs no work, while a surface that breaks
 * when called is a defect sitting behind an untested path waiting for the
 * first client who tries it.
 *
 * "Stale" and "unproven" are statements about USAGE. Reading them as "broken"
 * would send somebody building UI for OneNote because a report had a zero in
 * it, which is inventing work; reading them as "fine" leaves a real fault
 * undiscovered. So this calls each one once, read-only, with a real token, and
 * reports which of the two it is.
 *
 *   npx tsx scripts/integration-probe.ts
 *   npx tsx scripts/integration-probe.ts --user <connected_by>
 *
 * READ-ONLY BY CONSTRUCTION. Every entry point below is a list or a get. No
 * probe creates, updates, sends or deletes anything, because a diagnostic that
 * writes to somebody's mailbox to prove it can is not a diagnostic.
 *
 * IT REFUSES TO GUESS, and that rule was written after the first version of
 * this file lied. Run without Graph credentials, every stored token was
 * expired, MS_CLIENT_ID and MS_CLIENT_SECRET were unset so none could be
 * refreshed, and getValidToken returned null for everybody. The probe printed
 * a confident table anyway: three surfaces "genuinely broken", two "working".
 * Not one of those verdicts touched Microsoft. The failures were the missing
 * local credential, the successes were reads from the Postgres cache, and one
 * "crash" was this file's own summarizer.
 *
 * A diagnostic that reports findings it did not observe is worse than no
 * diagnostic, because somebody acts on it. So this now establishes a live
 * token FIRST and stops with nothing if it cannot, and a surface answered from
 * cache is reported as cache rather than as proof the integration works.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

/* Dynamic imports throughout: a static one is hoisted above config() and the
   pool is then built without a connection string. See scripts/brain-eval.ts. */

import type { ProbeResult } from "../src/lib/integrations/probe";

/* One implementation, two entry points. See src/lib/integrations/probe.ts for
   why the logic is not in this file. */
async function probeAll(userId: string): Promise<ProbeResult[]> {
  const m = await import("../src/lib/integrations/probe");
  return m.probeAll(userId);
}

async function main() {
  const i = process.argv.indexOf("--user");
  let userId = i >= 0 ? process.argv[i + 1] : "";

  if (!userId) {
    const { query } = await import("../src/lib/db");
    const { rows } = await query<{ connected_by: string }>(
      `SELECT connected_by FROM instinct_ms_tokens ORDER BY updated_at DESC LIMIT 1`,
    );
    userId = rows[0]?.connected_by ?? "";
  }
  if (!userId) {
    console.error("No connected Microsoft account. Pass --user <connected_by>.");
    process.exit(1);
  }

  /* THE CHECK THAT MAKES THE REST MEAN ANYTHING. Without a live token every
     Graph call fails identically for a reason that has nothing to do with the
     integration, and the table below would report that as breakage. Stop with
     nothing rather than produce findings nobody could act on correctly. */
  const { getValidToken } = await import("../src/lib/microsoft-graph");
  const token = await getValidToken(userId);
  if (!token) {
    console.error(
      [
        "",
        "Cannot probe: no live Microsoft token for this account.",
        "",
        "  Every Graph call would fail for that one reason, and a table of",
        "  failures would read as broken integrations. Nothing is reported.",
        "",
        "  Usual causes: the stored token has expired and MS_CLIENT_ID /",
        "  MS_CLIENT_SECRET are absent here, so it cannot be refreshed.",
        "  Run where those are set, or reconnect the account first.",
        "",
      ].join("\n"),
    );
    process.exit(2);
  }

  const results = await probeAll(userId);
  console.log("\nIntegration probe (read-only)\n");
  console.log("  surface              verdict         detail");
  console.log("  " + "-".repeat(64));
  for (const r of results) {
    console.log(`  ${r.label.padEnd(20)} ${r.verdict.padEnd(15)} ${r.detail}`);
  }
  const broken = results.filter((r) => r.verdict === "failed");
  const scopes = results.filter((r) => r.verdict === "scope_missing");
  const cached = results.filter((r) => r.verdict === "cache");
  console.log(
    `\n  ${broken.length} genuinely broken, ${scopes.length} awaiting a consent, ` +
      `${results.length - broken.length - scopes.length - cached.length} reached Graph, ` +
      `${cached.length} answered from cache and were not proved either way.\n`,
  );
}

if (require.main === module) {
  main().then(
    () => process.exit(0),
    (err) => {
      console.error("[integration-probe]", (err as Error).message);
      process.exit(1);
    },
  );
}
