/**
 * Read what each capability has actually done, from traces it already leaves.
 *
 * NOTHING HERE ASKS THE CAPABILITY HOW IT IS DOING. Every check reads a record
 * the working path wrote as a side effect of working. That is the whole design:
 * the four capabilities this register was built after were all configured,
 * tested and green, and none of them had ever run.
 *
 * A FAILED READ IS ITS OWN ANSWER. Each query returns null rather than zero
 * when it cannot run, because "no evidence" and "could not look for evidence"
 * lead to opposite actions and this register exists because they look alike.
 */

import { query } from "@/lib/db";
import {
  CAPABILITIES,
  verdictFor,
  HOT_CAPABILITIES,
  HOT_FRESH_DAYS,
  FRESH_DAYS,
  type Capability,
  type CapabilityStatus,
} from "./register";

interface Observation {
  count: number | null;
  lastSeen: string | null;
}

/** How many times an event has fired, and when it last did. */
async function fromEvents(event: string): Promise<Observation> {
  try {
    const { rows } = await query<{ n: string; last: string | null }>(
      `SELECT count(*)::text AS n, max(timestamp)::text AS last
         FROM instinct_events WHERE event_type = $1`,
      [event],
    );
    return { count: Number(rows[0]?.n ?? 0), lastSeen: rows[0]?.last ?? null };
  } catch {
    /* silent-ok: null IS the report. The caller turns it into "unknown", which
       is a different line on the page from "never", and the difference is the
       reason this file exists. */
    return { count: null, lastSeen: null };
  }
}

/**
 * Counts for capabilities that leave rows rather than events.
 *
 * Keyed by the label in the register so a new entry cannot silently point at
 * nothing: an unknown label returns null, which surfaces as "could not be
 * checked" rather than passing as zero.
 */
const COUNTERS: Record<string, () => Promise<Observation>> = {
  "queries with a semantic hit": async () => {
    const { rows } = await query<{ n: string; last: string | null }>(
      `SELECT count(*)::text AS n, max(created_at)::text AS last
         FROM brain_query_log WHERE semantic_hits > 0`,
    );
    return { count: Number(rows[0]?.n ?? 0), lastSeen: rows[0]?.last ?? null };
  },
  /* Runs, filtered to the ones that moved a document. The event alone fires on
     a run that repaired nothing, which is how the job reported success for
     weeks while doing none of its work. */
  "runs that actually repaired a document": async () => {
    const { rows } = await query<{ n: string; last: string | null }>(
      `SELECT count(*)::text AS n, max(timestamp)::text AS last
         FROM instinct_events
        WHERE event_type = 'brain.reprocess_run'
          AND coalesce((metadata->>'repaired')::int, 0) > 0`,
    );
    return { count: Number(rows[0]?.n ?? 0), lastSeen: rows[0]?.last ?? null };
  },
  "distinct models used in 30 days": async () => {
    const { rows } = await query<{ n: string; last: string | null }>(
      `SELECT count(DISTINCT model)::text AS n, max(day)::text AS last
         FROM v_ai_cost_daily WHERE day > now() - interval '30 days'`,
    );
    return { count: Number(rows[0]?.n ?? 0), lastSeen: rows[0]?.last ?? null };
  },
};

async function observe(c: Capability): Promise<Observation> {
  if (c.provenBy.kind === "event") return fromEvents(c.provenBy.event);
  const counter = COUNTERS[c.provenBy.label];
  if (!counter) return { count: null, lastSeen: null };
  try {
    return await counter();
  } catch {
    /* silent-ok: same reason as above. The verdict carries it. */
    return { count: null, lastSeen: null };
  }
}

export async function readCapabilities(now = new Date()): Promise<CapabilityStatus[]> {
  const out: CapabilityStatus[] = [];
  for (const c of CAPABILITIES) {
    const seen = await observe(c);
    const required =
      c.provenBy.kind === "count" ? c.provenBy.atLeast : (c.provenBy.atLeast ?? 1);
    out.push({
      capability: c,
      /* Something that fires on every question is stale in days, not weeks.
         A total outage of semantic search would otherwise read as healthy for
         six weeks, which is most of the way back to not checking. */
      verdict: verdictFor(
        seen.count,
        seen.lastSeen,
        required,
        now,
        HOT_CAPABILITIES.has(c.id) ? HOT_FRESH_DAYS : FRESH_DAYS,
      ),
      observations: seen.count ?? 0,
      lastSeen: seen.lastSeen,
    });
  }
  /* Worst first. A register read top to bottom should open on the thing that
     is not true. */
  const order = { never: 0, unknown: 1, stale: 2, demonstrated: 3 } as const;
  return out.sort((a, b) => order[a.verdict] - order[b.verdict]);
}
