/**
 * How much of the product answers without a model.
 *
 * This is the claim the whole thing rests on: it only uses AI when it has
 * to, and otherwise operates the client's tooling directly. Until now the
 * number was nowhere. The router page reported spend, which model was
 * picked and how the tiers split, all of which describe the calls we DID
 * make and none of which describe the ones we did not.
 *
 * Measured on production for the thirty days to 2026-08-23: 3,536
 * assistant replies, 47 of them from a model. 98.7% answered
 * deterministically.
 *
 * That number is worth more to a client than the spend figure beside it,
 * and it is worth more to us than a claim in a deck, because a claim
 * cannot regress and a number can. If a change starts pushing work back
 * to a model this is where it shows.
 *
 * THE SECOND NUMBER IS THE ONE TO ACT ON. Those 47 replies used 101,644
 * tokens between them, about 2,163 each. With call volume already at
 * 1.3%, there is almost nothing left to win by answering fewer questions
 * with a model, and everything to win by making each of those calls
 * smaller. Reporting the average alongside the share is what keeps
 * attention on the lever that still moves.
 */

import { safeQuery } from "@/lib/db";

export interface DeterministicShare {
  /** Assistant replies in the window. */
  replies: number;
  /** How many of them came from a model. */
  modelReplies: number;
  /** 0-1. The headline: how much of the product runs without AI. */
  share: number;
  /** Total tokens across the model replies. */
  tokens: number;
  /**
   * Tokens per model reply. The lever that still has room in it once the
   * share is this high.
   */
  avgTokensPerModelReply: number;
  /** Where the zero-token answers came from, largest first. */
  bySource: Array<{ source: string; replies: number }>;
}

const EMPTY: DeterministicShare = {
  replies: 0,
  modelReplies: 0,
  share: 0,
  tokens: 0,
  avgTokensPerModelReply: 0,
  bySource: [],
};

export async function getDeterministicShare(days: number): Promise<DeterministicShare> {
  const totals = await safeQuery<{
    replies: string;
    model_replies: string;
    tokens: string;
  }>(
    `SELECT COUNT(*)::bigint AS replies,
            COUNT(*) FILTER (WHERE COALESCE(tokens_used, 0) > 0)::bigint AS model_replies,
            COALESCE(SUM(tokens_used), 0)::bigint AS tokens
       FROM instinct_messages
      WHERE role = 'assistant'
        AND created_at > NOW() - ($1::bigint || ' days')::interval`,
    [days],
  );

  const row = totals.rows[0];
  if (!row) return EMPTY;

  const replies = Number(row.replies) || 0;
  const modelReplies = Number(row.model_replies) || 0;
  const tokens = Number(row.tokens) || 0;
  if (replies === 0) return EMPTY;

  const bySource = await safeQuery<{ source: string | null; n: string }>(
    `SELECT source, COUNT(*)::bigint AS n
       FROM instinct_messages
      WHERE role = 'assistant'
        AND COALESCE(tokens_used, 0) = 0
        AND created_at > NOW() - ($1::bigint || ' days')::interval
      GROUP BY source
      ORDER BY n DESC
      LIMIT 8`,
    [days],
  );

  return {
    replies,
    modelReplies,
    /* Rounded to four places rather than presented as a percentage
       string: a caller charting this over time needs the number, and a
       page can format it. */
    share: Math.round(((replies - modelReplies) / replies) * 10_000) / 10_000,
    tokens,
    avgTokensPerModelReply: modelReplies > 0 ? Math.round(tokens / modelReplies) : 0,
    bySource: (bySource.rows ?? []).map((r) => ({
      source: r.source ?? "unattributed",
      replies: Number(r.n) || 0,
    })),
  };
}
