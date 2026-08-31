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
  runFinancialsMetricOutcome,
  type FinancialsFailure,
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

/**
 * "Spend" is also a word about time.
 *
 * "how should I spend today" reached the financials tool, because spend
 * is a money hint and the sentence is a question. Same shape as "arr"
 * inside "warranty": a word that means one thing in this tool's domain
 * and another in ordinary speech.
 *
 * The tell is what is being spent. Money has an amount or a period
 * attached; a day, a morning and an hour are time, and somebody asking
 * how to spend one is asking about their diary.
 */
const SPENDING_TIME_RE =
  /\bspend\s+(?:my\s+|the\s+|his\s+|her\s+|their\s+)?(?:time|day|morning|afternoon|week|hour|evening)\b|\bhow\s+should\s+i\s+spend\s+(?:today|tomorrow|this\s+\w+)\b/i;

function matchFinancialsIntent(message: string): Params | null {
  if (SPENDING_TIME_RE.test(message)) return null;
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

/**
 * What to say when there is no number, per reason.
 *
 * None of these suggests a rephrasing unless rephrasing is genuinely the fix.
 * Offering one for a disconnected accounting system sends somebody round a
 * loop they cannot get out of by trying harder.
 */
function messageFor(reason: FinancialsFailure): string {
  switch (reason) {
    case "not_connected":
      return (
        "I understood the question, but financials are not connected yet, so there is no figure to " +
        "read. Connect QuickBooks in Admin, Connectors and I will be able to answer this."
      );
    case "no_data":
      return (
        "Financials are connected, but there is nothing recorded for that period. Try a different " +
        "timeframe, or check the Financials page for what is there."
      );
    case "not_authorized":
      return "Financial figures are limited to admin roles, so I cannot answer that one.";
    case "unknown_metric":
      /* The only case where the user's wording is genuinely the problem, and
         the only one that should ever ask them to rephrase. */
      return (
        "I could not tell which financial metric you meant. I can answer revenue, net profit, cash " +
        "position, unpaid invoices and aged receivables."
      );
  }
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
      const outcome = await runFinancialsMetricOutcome({
        question: params.question,
        timeframeToken: params.timeframe,
        userRole: ctx.userRole,
      });
      if (!outcome.ok) {
        /* SAY WHAT ACTUALLY HAPPENED. Every one of these used to render the
           same sentence: "I couldn't find a matching financial metric. Try a
           more specific question like 'what was our MRR last month?'"
           Asked "what's our MRR", the product understood perfectly,
           classified it as revenue, found QuickBooks unconnected, and blamed
           the wording. Anybody who followed the suggestion asked the exact
           question that had just failed and got the identical error. A
           suggestion that cannot work is worse than no suggestion, because it
           spends the person's second attempt as well as their first. */
        return {
          ok: true,
          data: {
            metric: null,
            value: null,
            answer: outcome.reason,
          } as unknown as FinancialsMetricResult,
          answer: messageFor(outcome.reason),
          sources: [],
        };
      }
      const result = outcome.result;
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
