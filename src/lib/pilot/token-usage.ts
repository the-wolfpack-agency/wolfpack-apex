/**
 * What the models actually consumed, read from the completion log.
 *
 * Every model call writes an ai.completion event carrying its own input and
 * output token counts and what it cost. Summing them is the only honest basis
 * for a cost comparison: an estimate from message lengths would be a guess
 * dressed as a measurement.
 *
 * UNREADABLE IS NOT ZERO, the rule this dashboard runs on. A failed read
 * returns null so the page can say the figures could not be read, rather than
 * rendering a comparison against zero tokens and claiming we spent nothing.
 */

import { query } from "@/lib/db";
import type { TokenUsage } from "./model-cost-comparison";

export async function getTokenUsage(days: number): Promise<TokenUsage | null> {
  const bounded = Math.max(1, Math.min(365, Math.floor(days)));
  try {
    const { rows } = await query<{
      calls: string;
      inp: string;
      out: string;
      usd: string;
    }>(
      `SELECT count(*)::text AS calls,
              COALESCE(sum((metadata->>'input_tokens')::numeric), 0)::text  AS inp,
              COALESCE(sum((metadata->>'output_tokens')::numeric), 0)::text AS out,
              COALESCE(sum((metadata->>'cost_usd')::numeric), 0)::text      AS usd
         FROM instinct_events
        WHERE event_type = 'ai.completion'
          AND timestamp > NOW() - ($1::int * INTERVAL '1 day')
          /* Some rows carry a fingerprint rather than a count, from a period
             when token values were hashed before storage. Those cannot be
             summed, and including them as zero would understate the total and
             flatter the comparison. */
          AND metadata->>'input_tokens' ~ '^[0-9]+$'
          AND metadata->>'output_tokens' ~ '^[0-9]+$'`,
      [bounded],
    );

    const r = rows[0];
    if (!r) return null;
    return {
      calls: Number(r.calls),
      inputTokens: Number(r.inp),
      outputTokens: Number(r.out),
      actualUsd: Number(r.usd),
    };
  } catch {
    return null;
  }
}
