/**
 * Which models the router actually chose, and what each cost per token.
 *
 * WHY PER TOKEN AND NOT PER CALL
 *
 * Per call is the number that misleads. Measured on 2026-08-30, llama served
 * 122 calls for $0.4166 while gpt-4o served 10 for $0.0058, which reads as
 * llama being six times dearer and is an artefact of llama handling much longer
 * prompts. Per token it is 2.4x CHEAPER than the model it replaces.
 *
 * WHY WITHIN A TIER AND NOT ACROSS
 *
 * gpt-4o-mini at $0.00038 looks cheaper than everything, and it should: it
 * serves the cheap tier and answers shorter questions. Comparing it to a
 * standard-tier model says only that cheap work is cheaper. The claim worth
 * making is that AT THE SAME TIER the router picks the cheaper vendor, and that
 * is what this groups by.
 *
 * WHAT IT SETTLES
 *
 * "We can use models other than OpenAI" was an architecture claim with one call
 * behind it. It is now 122 calls at the standard tier, and the alternative is
 * measurably cheaper for the same work. That is the difference between a
 * capability and a slide.
 */
/* FIRST. Imports hoist, so anything below already read process.env. */
import "./load-env";
import { query } from "@/lib/db";

interface Row extends Record<string, unknown> {
  model: string;
  provider: string;
  tier: string;
  calls: string;
  tokens: string;
  usd: string;
  per1k: string;
}

async function main(): Promise<void> {
  const days = Number(process.argv[2] ?? 14);
  const { rows } = await query<Row>(
    `SELECT metadata->>'selected_model_id' AS model,
            metadata->>'provider' AS provider,
            metadata->>'tier' AS tier,
            count(*)::text AS calls,
            sum((metadata->>'input_tokens')::numeric + (metadata->>'output_tokens')::numeric)::text AS tokens,
            round(sum((metadata->>'cost_usd')::numeric), 4)::text AS usd,
            round(1000 * sum((metadata->>'cost_usd')::numeric)
                  / nullif(sum((metadata->>'input_tokens')::numeric
                             + (metadata->>'output_tokens')::numeric), 0), 5)::text AS per1k
       FROM instinct_events
      WHERE event_type = 'ai.completion'
        AND timestamp > now() - ($1 || ' days')::interval
        AND metadata->>'selected_model_id' IS NOT NULL
        /* Hashed fingerprints appear where token counts were redacted; they
           would poison every average silently. */
        AND metadata->>'input_tokens' ~ '^[0-9]+$'
      GROUP BY 1, 2, 3
      ORDER BY tier, per1k`,
    [String(days)],
  );

  if (rows.length === 0) {
    console.log(`No model calls recorded in the last ${days} days.`);
    process.exit(0);
  }

  console.log(`Models the router chose, last ${days} days\n`);
  let tier = "";
  for (const r of rows) {
    if (r.tier !== tier) {
      tier = r.tier;
      console.log(`  ${tier} tier`);
    }
    console.log(
      `    ${r.model.padEnd(22)} ${String(r.calls).padStart(5)} calls  ` +
        `$${r.per1k}/1k tokens  ($${r.usd} total)`,
    );
  }

  /* The comparison that matters, stated only where it is true: two models at
     the SAME tier, so the cheaper one is cheaper for the same work. */
  const byTier = new Map<string, Row[]>();
  for (const r of rows) byTier.set(r.tier, [...(byTier.get(r.tier) ?? []), r]);
  console.log("");
  for (const [t, group] of byTier) {
    if (group.length < 2) continue;
    const cheapest = group[0]!;
    const dearest = group[group.length - 1]!;
    const ratio = Number(dearest.per1k) / Number(cheapest.per1k);
    console.log(
      `  At the ${t} tier, ${cheapest.model} is ${ratio.toFixed(1)}x cheaper per token ` +
        `than ${dearest.model}, and served ${cheapest.calls} calls to its ${dearest.calls}.`,
    );
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
