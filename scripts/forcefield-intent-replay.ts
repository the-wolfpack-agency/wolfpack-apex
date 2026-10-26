/**
 * Forcefield intent replay: run the intent scoring over the last N days of
 * recorded site events and print AGGREGATE numbers only (no paths, sigs,
 * fingerprints or countries are printed).
 *
 *   npm run forcefield:intent-replay            # 30 days
 *   FORCEFIELD_REPLAY_DAYS=7 npm run forcefield:intent-replay
 *
 * READ-ONLY: the session is put in default_transaction_read_only before the one
 * SELECT runs. Needs DATABASE_URL. No IP is stored in site_analytics_events, so
 * none can be read here. See src/lib/forcefield/intent-replay.ts for what the
 * replay can and cannot see.
 */
import { Client } from "pg";
import { replayIntent, type ReplayEvent } from "../src/lib/forcefield/intent-replay";
import { INTENT_THRESHOLDS } from "../src/lib/forcefield-web/intent";

/** Declared stacks of the first-party Forcefield sites (all Next.js on Vercel).
 *  The same values the sites pass as ForcefieldArgs.stack. */
const STACKS: Record<string, string[]> = {
  instinct: ["nextjs"],
  weekendwithporsche: ["nextjs"],
  aidanmulready: ["nextjs"],
  "ogiam.com": ["nextjs"],
};

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
      ts: string; t: string; p: string | null; site: string | null; sig: string | null; fp: string | null; ct: string | null;
      probe: string | null; attack: string | null; auth: string | null; syn: string | null; country: string | null;
    }>(
      `SELECT extract(epoch from created_at) * 1000 AS ts, event_type AS t, path AS p,
              props->>'site' AS site, props->>'sig' AS sig, props->>'fp' AS fp, props->>'client_type' AS ct,
              props->>'probe' AS probe, props->>'attack' AS attack, props->>'authenticated' AS auth,
              props->>'synthetic' AS syn, country
         FROM site_analytics_events
        WHERE created_at > now() - ($1 || ' days')::interval
        ORDER BY created_at`,
      [String(days)],
    );
    const events: ReplayEvent[] = r.rows.map((x) => ({
      ts: Number(x.ts),
      type: x.t,
      path: x.p ?? "",
      site: x.site ?? "",
      sig: x.sig ?? "",
      fp: x.fp,
      clientType: x.ct,
      probe: x.probe,
      attack: x.attack,
      authenticated: x.auth === "true",
      synthetic: x.syn === "true",
      country: x.country,
    }));
    const report = replayIntent(events, { stacks: STACKS });
    console.log(JSON.stringify({ days, rows: events.length, thresholds: INTENT_THRESHOLDS, ...report }, null, 2));
    // Sensitivity: the same replay at neighbouring tarpit thresholds, so a
    // threshold change is a measured decision, not a guess.
    const sweep = [3, 4, 5, 6, 7].map((tarpit) => {
      const r = replayIntent(events, { stacks: STACKS, thresholds: { ...INTENT_THRESHOLDS, tarpit } });
      return {
        tarpit,
        hostileTarpittedBeforeProof: r.hostile.tarpittedBeforeProof,
        medianRequestsEarlier: r.hostile.medianRequestsEarlier,
        medianSecondsEarlier: r.hostile.medianSecondsEarlier,
        reconOnlyTarpitted: r.neverHostile.reconOnlyTarpitted,
        unlabeledAutomationTarpitted: r.neverHostile.unlabeledAutomationTarpitted,
        knownBenignTarpitted: r.neverHostile.knownBenignTarpitted,
      };
    });
    console.log(JSON.stringify({ sweep }, null, 2));
  } finally {
    await c.end();
  }
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
