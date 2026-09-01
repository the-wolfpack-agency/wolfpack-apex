/**
 * Record what AI cost before the router.
 *
 * WHAT IS RECORDED IS EXACTLY WHAT WAS PROVIDED, AND NOTHING ELSE.
 *
 * Three invoices were given: January, and payments settled on 28 February and
 * 28 March 2026, with the March figure described as the current recurring
 * amount. April through the present were NOT provided, so they are not written
 * as invoices. They can be written as `recurring_estimate` rows with --fill,
 * which is a different kind in the table and reads differently on the page,
 * because an assumption presented as an invoice is how a comparison stops being
 * believed the first time somebody checks it.
 *
 * A payment settled on 28 February is recorded against FEBRUARY. Attributing a
 * subscription payment to the month it cleared would shift the whole history by
 * one and make every month-on-month comparison wrong by a billing cycle.
 *
 * Usage:
 *   npx tsx scripts/record-ai-spend-baseline.ts --dry-run
 *   npx tsx scripts/record-ai-spend-baseline.ts
 *   npx tsx scripts/record-ai-spend-baseline.ts --fill 2026-08   # assume the
 *       recurring rate for every month after March up to and including this one
 * Needs: DATABASE_URL
 */
/* FIRST. Imports hoist, so anything below already read process.env. */
import "./load-env";
import { query } from "@/lib/db";
import { toCents } from "@/lib/ai/spend-baseline";

const DRY = process.argv.includes("--dry-run");
const fillIdx = process.argv.indexOf("--fill");
const fillUntil = fillIdx > -1 ? process.argv[fillIdx + 1] : null;

const WORKSPACE = process.env.BASELINE_WORKSPACE_ID ?? "default";
const NOTE = "AI subscription invoiced before the router was in use";

interface Entry {
  month: string;
  usd: number;
  kind: "invoiced" | "recurring_estimate";
  note: string;
}

/** The figures as given. Nothing inferred. */
const INVOICED: Entry[] = [
  { month: "2026-01-01", usd: 21.78, kind: "invoiced", note: NOTE },
  { month: "2026-02-01", usd: 87.77, kind: "invoiced", note: `${NOTE} (settled 28 Feb 2026)` },
  { month: "2026-03-01", usd: 108.88, kind: "invoiced", note: `${NOTE} (settled 28 Mar 2026)` },
];

/** The rate described as current, applied forward only when asked. */
const RECURRING_USD = 108.88;

function monthsAfterMarchUpTo(endMonth: string): string[] {
  const [y, m] = endMonth.split("-").map(Number);
  if (!y || !m) throw new Error(`--fill needs a YYYY-MM month, got "${endMonth}"`);
  const out: string[] = [];
  let year = 2026;
  let month = 4; // April, the first month not covered by an invoice above.
  while (year < y || (year === y && month <= m)) {
    out.push(`${year}-${String(month).padStart(2, "0")}-01`);
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return out;
}

async function main(): Promise<void> {
  const entries = [...INVOICED];
  if (fillUntil) {
    for (const month of monthsAfterMarchUpTo(fillUntil)) {
      entries.push({
        month,
        usd: RECURRING_USD,
        kind: "recurring_estimate",
        note: "Assumed from the March 2026 rate, described as the current monthly amount. Not an invoice.",
      });
    }
  }

  if (DRY) {
    console.log(`[baseline] DRY RUN: ${entries.length} rows for workspace "${WORKSPACE}"`);
    for (const e of entries) {
      console.log(`  ${e.month}  $${e.usd.toFixed(2)}  ${e.kind}`);
    }
    return;
  }

  for (const e of entries) {
    /* Upsert on (workspace, month): re-running corrects a figure rather than
       adding a second row and quietly doubling the baseline. */
    await query(
      `INSERT INTO ai_spend_baseline (workspace_id, period_month, amount_cents, kind, note)
       VALUES ($1, $2::date, $3, $4, $5)
       ON CONFLICT (workspace_id, period_month) DO UPDATE SET
         amount_cents = EXCLUDED.amount_cents,
         kind         = EXCLUDED.kind,
         note         = EXCLUDED.note,
         updated_at   = NOW()`,
      [WORKSPACE, e.month, toCents(e.usd), e.kind, e.note],
    );
  }
  console.log(`[baseline] recorded ${entries.length} month(s) for workspace "${WORKSPACE}".`);
}

main().catch((err) => {
  console.error("[baseline] failed:", (err as Error).message);
  process.exit(1);
});
