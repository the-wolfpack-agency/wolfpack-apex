/**
 * Prove SharePoint search against the real tenant, or say why it could not.
 *
 * WHY A SCRIPT AND NOT A TEST. The unit suites stub fetch, so they prove the
 * parser and the reason codes and nothing about whether Microsoft answers us.
 * This codebase keeps getting caught by that gap: the external agent gate had a
 * complete unit suite and its key table had never held a row, and every
 * Microsoft cache table in production is empty because the poller that was
 * meant to fill them was never written.
 *
 * This asks Microsoft. It needs MS_CLIENT_ID and a connected account, which is
 * why it cannot run in CI and must not be a test that skips quietly.
 *
 *   npx tsx scripts/sharepoint-search-check.ts
 *   npx tsx scripts/sharepoint-search-check.ts "payment terms"
 *
 * WHAT IT REFUSES TO CLAIM. Zero hits is not a pass. A tenant that answered and
 * held nothing matching looks identical from here to a query that was never
 * really run, so a run that finds nothing exits non-zero and says so.
 */

/* FIRST. Imports hoist, so anything below already read process.env. */
import "./load-env";
import { query } from "@/lib/db";
import { getValidToken } from "@/lib/microsoft-graph";
import { searchSharePoint } from "@/lib/integrations/microsoft-sharepoint";

const DEFAULT_QUERIES = ["coaching calls", "sow", "survey"];

async function main() {
  if (!process.env.MS_CLIENT_ID) {
    console.error(
      "MS_CLIENT_ID is not set, so getValidToken short-circuits to shadow mode\n" +
        "and every account reports not_connected. That is this machine's\n" +
        "configuration, not a fact about the tenant. Run with real credentials.",
    );
    process.exit(2);
  }

  const asked = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const queries = asked.length > 0 ? asked : DEFAULT_QUERIES;

  const { rows } = await query<{ connected_by: string; user_email: string }>(
    `SELECT connected_by, user_email FROM instinct_ms_tokens ORDER BY updated_at DESC NULLS LAST`,
  );
  if (rows.length === 0) {
    console.error("No connected Microsoft accounts. Nothing to prove against.");
    process.exit(2);
  }
  console.log(`${rows.length} connected account(s).\n`);

  let anyHits = false;
  for (const row of rows) {
    /* connected_by is the Instinct user id and user_email is the mailbox.
       getValidToken accepts either, and which one resolves tells you whether
       the token is still anchored to a user row that exists. */
    for (const key of [row.connected_by, row.user_email].filter(Boolean)) {
      const auth = await getValidToken(key).catch(() => null);
      if (!auth?.accessToken) {
        console.log(`  ${key}  ->  no usable token`);
        continue;
      }
      for (const q of queries) {
        const r = await searchSharePoint(auth.accessToken, { query: q, topN: 5 });
        if (!r.ok) {
          console.log(`  ${key}  "${q}"  ->  ${r.code}`);
          continue;
        }
        console.log(
          `  ${key}  "${q}"  ->  ${r.value.hits.length} hit(s)  [sent: ${r.value.query_string_sent}]`,
        );
        for (const h of r.value.hits.slice(0, 3)) console.log(`      ${h.title}`);
        if (r.value.hits.length > 0) anyHits = true;
      }
    }
  }

  if (!anyHits) {
    console.error(
      "\nNo hits from any account on any query. That is NOT a pass: a tenant that\n" +
        "answered and held nothing looks the same from here as a query that never\n" +
        "really ran. Check Sites.Read.All consent before concluding the library\n" +
        "is empty.",
    );
    process.exit(1);
  }

  console.log("\nSharePoint answered with real files, searched in place, nothing downloaded.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
