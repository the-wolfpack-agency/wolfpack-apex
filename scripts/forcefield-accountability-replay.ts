/**
 * Forcefield accountable-actions replay: run the accountability verdict over
 * the last N days of recorded site events and print AGGREGATE counts only (no
 * paths, principals, sigs, fingerprints or countries are printed).
 *
 *   npm run forcefield:accountability-replay            # 30 days
 *   FORCEFIELD_REPLAY_DAYS=14 npm run forcefield:accountability-replay
 *
 * READ-ONLY: the session is put in default_transaction_read_only before the one
 * SELECT runs. Needs DATABASE_URL. See src/lib/forcefield/accountability-replay.ts
 * for what history can and cannot show.
 */
import { Client } from "pg";
import { replayAccountability, type ReplayRow } from "../src/lib/forcefield/accountability-replay";

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is required");
    process.exit(2);
  }
  const days = Math.max(1, Math.min(90, Number(process.env.FORCEFIELD_REPLAY_DAYS ?? 30) || 30));
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    await c.query("SET default_transaction_read_only = on");
    const r = await c.query<{
      t: string; p: string | null; site: string | null; ct: string | null; hosting: string | null; auth: string | null; syn: string | null;
      agent: string | null; signed: string | null; ps: string | null; scopes: string | null; acct: string | null; hold: string | null;
    }>(
      `SELECT event_type AS t, path AS p, coalesce(props->>'site', 'ogiam.com') AS site, props->>'client_type' AS ct,
              props->>'hosting' AS hosting, props->>'authenticated' AS auth, props->>'synthetic' AS syn,
              props->>'agent' AS agent, props->>'signed_agent' AS signed, props->>'principal_status' AS ps,
              props->>'principal_scopes' AS scopes, props->>'accountability' AS acct, props->>'would_hold' AS hold
         FROM site_analytics_events
        WHERE created_at > now() - ($1 || ' days')::interval`,
      [String(days)],
    );
    const rows: ReplayRow[] = r.rows.map((x) => {
      let scopes: string[] = [];
      try {
        const parsed = x.scopes ? JSON.parse(x.scopes) : [];
        if (Array.isArray(parsed)) scopes = parsed.filter((s): s is string => typeof s === "string");
      } catch {
        scopes = [];
      }
      return {
        type: x.t,
        path: x.p ?? "",
        site: x.site ?? "ogiam.com",
        clientType: x.ct,
        hosting: x.hosting,
        authenticated: x.auth === "true",
        synthetic: x.syn === "true",
        identifiedAgent: x.signed === "true" || (!!x.agent && x.agent !== "unidentified"),
        principalStatus: x.ps,
        principalScopes: scopes,
        accountability: x.acct,
        wouldHold: x.hold === null ? null : x.hold === "true",
      };
    });
    console.log(JSON.stringify({ days, ...replayAccountability(rows) }, null, 2));
  } finally {
    await c.end();
  }
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
