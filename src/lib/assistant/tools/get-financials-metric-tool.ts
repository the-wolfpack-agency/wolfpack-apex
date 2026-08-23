/**
 * get_financials_metric tool — wraps runFinancialsMetric().
 *
 * Answers questions of the form:
 *   "What's our revenue this quarter?"
 *   "How much did we spend on marketing last month?"
 *   "Show me our burn rate"
 *
 * CTO/CEO only. Lower roles get a capability failure (the underlying
 * handler enforces this too — defense in depth).
 */

import { z } from "zod";
import {
  runFinancialsMetric,
  type FinancialsMetricResult,
} from "./financials-metric";
import { registerTool } from "./registry";
import type { ToolDef, ToolResult } from "./types";

const ParamSchema = z.object({
  question: z.string().min(3).max(240),
  timeframe: z.string().min(2).max(40).optional(),
});
type Params = z.infer<typeof ParamSchema>;

const FINANCIAL_HINTS = [
  "revenue", "income", "earnings", "profit", "loss", "margin",
  "burn", "runway", "cash", "mrr", "arr", "spend", "spent",
  "expenses", "cost", "costs", "budget", "p&l", "p and l",
  "gross", "net income",
];

const FINANCIAL_TIMEFRAMES = [
  "this quarter", "last quarter", "this month", "last month",
  "this year", "last year", "ytd", "year to date", "this week",
  "last week", "today", "yesterday",
];

/**
 * A HINT HAS TO BE A WORD, NOT A RUN OF LETTERS.
 *
 * This matched with includes(), so "arr" found itself inside w-arr-anty
 * and the financials tool claimed every sentence about warranty work.
 * Measured against the deployed assistant on 2026-08-23: "I look after
 * warranty claims for three dealerships, what would you do first?" was
 * answered with "that tool needs a higher-privilege role", which reads
 * like a permissions problem and is really a three-letter acronym
 * matching the middle of the most important word this client uses.
 *
 * The short financial acronyms are where substring matching does the most
 * damage: arr is inside warranty, arrears, carrier and arrival; mrr and
 * ytd have the same shape. Word boundaries cost nothing and remove the
 * whole class.
 *
 * p&l keeps its own handling because the ampersand is not a word
 * character, so a boundary either side of it never matches.
 */
const HINT_RES: RegExp[] = FINANCIAL_HINTS.map((h) =>
  /[^a-z0-9]/.test(h)
    ? new RegExp(h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i")
    : new RegExp(`\\b${h}\\b`, "i"),
);

function matchFinancialsIntent(message: string): Params | null {
  const lower = message.toLowerCase();
  /* Require both a financial-term keyword AND a question-y framing
     so casual mentions ("revenue is up") don't accidentally fire. */
  const hasHint = HINT_RES.some((re) => re.test(lower));
  if (!hasHint) return null;
  const isQuestion =
    /^(what|how|when|where|tell|show|give)\b/i.test(message.trim()) ||
    message.trim().endsWith("?");
  if (!isQuestion) return null;

  /* Extract timeframe if present. */
  let timeframe: string | undefined;
  for (const tf of FINANCIAL_TIMEFRAMES) {
    if (lower.includes(tf)) {
      timeframe = tf;
      break;
    }
  }
  return { question: message.trim(), timeframe };
}

export const getFinancialsMetricTool: ToolDef<Params, FinancialsMetricResult> = {
  name: "get_financials_metric",
  description:
    "Look up a financial metric (revenue, spend, burn, etc.) for a timeframe. Admin-only — CEO/CTO.",
  paramSchema: ParamSchema,
  capability: "cto",
  matchIntent: matchFinancialsIntent,
  async handler(params, ctx): Promise<ToolResult<FinancialsMetricResult>> {
    try {
      const result = await runFinancialsMetric({
        question: params.question,
        timeframeToken: params.timeframe,
        userRole: ctx.userRole,
      });
      if (!result) {
        return {
          ok: true,
          data: { metric: null, value: null, answer: "no_data" } as unknown as FinancialsMetricResult,
          answer:
            "I couldn't find a matching financial metric. Try a more specific question like 'what was our MRR last month?'",
        };
      }
      const ans =
        (result as { answer?: string }).answer ??
        "I found the metric but don't have a formatted summary.";
      return { ok: true, data: result, answer: ans };
    } catch (err) {
      return {
        ok: false,
        code: "internal",
        message: `get_financials_metric error: ${(err as Error)?.message ?? "unknown"}`,
      };
    }
  },
};

registerTool(getFinancialsMetricTool);
