/**
 * aggregate_external_records — count / sum / win-rate / top-N over a
 * CRM object set.
 *
 * Five intent classes:
 *   1. "how many <objects> [filter]"             → count
 *   2. "total <field> of <objects> [filter]"     → sum
 *   3. "average <field> of <objects> [filter]"   → avg
 *   4. "what's [my] win rate [period]"           → win_rate
 *   5. "top <N> <objects> by <field>"            → top
 *
 * Filter clauses (amount/date/stage/owner) from filter_external_records
 * are reused — "how many deals over $50k closing this month" composes
 * a count operation with the same FilterSpec the filter tool would have
 * built. Same regex extractors; same SOQL builder paths.
 */

import { z } from "zod";
import {
  buildRestConnectorForWorkspace,
  pickConfiguredConnector,
} from "@/lib/assistant/connectors";
import { trackEvent } from "@/lib/analytics";
import { registerTool } from "./registry";
import type { ToolDef, ToolResult } from "./types";
import type {
  FilterSpec,
  AggregateResult,
  AggregateSpec,
} from "@/lib/assistant/connectors/vendor-presets";
import { withSourceFooter } from "./source-footer";

const OBJECT_TYPES = ["contact", "deal", "opportunity", "account"] as const;
type ObjectType = (typeof OBJECT_TYPES)[number];
const OPERATIONS = ["count", "sum", "avg", "win_rate", "top"] as const;
type Operation = (typeof OPERATIONS)[number];

const ParamSchema = z.object({
  objectType: z.enum(OBJECT_TYPES),
  operation: z.enum(OPERATIONS),
  field: z.string().min(1).max(40).optional(),
  limit: z.number().int().min(1).max(25).optional(),
  filters: z.object({
    amount: z.object({ op: z.enum(["gt", "lt", "gte", "lte", "eq"]), value: z.number() }).optional(),
    dateRange: z
      .enum(["this_week", "last_week", "this_month", "last_month", "next_month", "this_quarter", "this_year"])
      .optional(),
    stage: z.string().min(1).max(40).optional(),
    ownerName: z.string().min(2).max(80).optional(),
  }).optional(),
  connector: z.string().min(1).max(40).default("rest-default"),
});
type Params = z.infer<typeof ParamSchema>;

interface AggregateData {
  connector: string;
  objectType: string;
  operation: Operation;
  result: AggregateResult;
}

/* ---------------------------------------------------------------------
 * Filter extractor — reused conceptually from filter_external_records.
 * Inlined here so the two tools don't have a dependency, but the logic
 * mirrors filter-external-records-tool's extractFilters().
 * ------------------------------------------------------------------- */

function parseAmount(raw: string): number | null {
  const m = /\$?(\d+(?:,\d{3})*(?:\.\d+)?)\s*([kKmM])?/.exec(raw);
  if (!m) return null;
  const base = Number(m[1].replace(/,/g, ""));
  if (Number.isNaN(base)) return null;
  const suffix = m[2]?.toLowerCase();
  if (suffix === "k") return base * 1000;
  if (suffix === "m") return base * 1_000_000;
  return base;
}

function extractFilters(msg: string): FilterSpec {
  const f: FilterSpec = {};
  const amountMatch =
    /\b(over|above|more\s+than|greater\s+than|>=?|under|below|less\s+than|<=?)\s+(\$?[\d,]+(?:\.\d+)?(?:\s*[kKmM])?)/i.exec(msg);
  if (amountMatch) {
    const word = amountMatch[1].toLowerCase().replace(/\s+/g, " ");
    const opMap: Record<string, NonNullable<FilterSpec["amount"]>["op"]> = {
      over: "gt", above: "gt", "more than": "gt", "greater than": "gt", ">": "gt", ">=": "gte",
      under: "lt", below: "lt", "less than": "lt", "<": "lt", "<=": "lte",
    };
    const op = opMap[word];
    const v = parseAmount(amountMatch[2]);
    if (op && v !== null) f.amount = { op, value: v };
  }
  if (/\b(this\s+month|closing\s+this\s+month)\b/i.test(msg)) f.dateRange = "this_month";
  else if (/\b(last\s+month|closed\s+last\s+month)\b/i.test(msg)) f.dateRange = "last_month";
  else if (/\b(next\s+month)\b/i.test(msg)) f.dateRange = "next_month";
  else if (/\b(this\s+week)\b/i.test(msg)) f.dateRange = "this_week";
  else if (/\b(last\s+week)\b/i.test(msg)) f.dateRange = "last_week";
  else if (/\b(this\s+quarter)\b/i.test(msg)) f.dateRange = "this_quarter";
  else if (/\b(this\s+year)\b/i.test(msg)) f.dateRange = "this_year";

  const stageMatch =
    /\b(?:stuck\s+)?in\s+(?:stage\s+)?(Closed\s+Won|Closed\s+Lost|Discovery|Proposal|Negotiation|Qualification|Prospecting|Needs\s+Analysis)\b/i.exec(msg);
  if (stageMatch) f.stage = stageMatch[1].trim();

  const ownerMatch =
    /\bowned\s+by\s+([A-Z][\w'.-]+(?:\s+[A-Z][\w'.-]+)?)/i.exec(msg) ??
    /\b([A-Z][\w'.-]+(?:\s+[A-Z][\w'.-]+)?)\s+owns\b/.exec(msg);
  if (ownerMatch) f.ownerName = ownerMatch[1].trim();
  return f;
}

/* ---------------------------------------------------------------------
 * Intent matching
 * ------------------------------------------------------------------- */

const OBJECT_ALIAS: Record<string, ObjectType> = {
  contact: "contact", contacts: "contact",
  deal: "deal", deals: "deal", opportunity: "opportunity", opportunities: "opportunity",
  account: "account", accounts: "account", company: "account", companies: "account",
};

function detectObject(msg: string): ObjectType | null {
  const m = /\b(deals?|opportunit(?:y|ies)|contacts?|accounts?|compan(?:y|ies))\b/i.exec(msg);
  return m ? OBJECT_ALIAS[m[1].toLowerCase()] ?? null : null;
}

function matchAggregateIntent(message: string): Params | null {
  const trimmed = message.trim();

  /* Win-rate is the most specific phrase — match first. */
  if (/\b(?:win\s+rate|win\/loss|conversion\s+rate)\b/i.test(trimmed)) {
    return {
      objectType: "opportunity",
      operation: "win_rate",
      filters: extractFilters(trimmed),
      connector: "rest-default",
    };
  }

  /* Top N: "top 5 accounts by revenue", "top 10 deals by amount" */
  const topMatch = /\btop\s+(\d{1,2})\s+(deals?|opportunit(?:y|ies)|contacts?|accounts?|compan(?:y|ies))(?:\s+by\s+([\w\s]+?))?\s*$/i.exec(trimmed);
  if (topMatch) {
    const objectType = OBJECT_ALIAS[topMatch[2].toLowerCase()];
    if (objectType) {
      const fieldHint = topMatch[3]?.trim().toLowerCase();
      const field =
        fieldHint === "amount" ? "Amount" :
        fieldHint === "revenue" || fieldHint === "annual revenue" ? "AnnualRevenue" :
        undefined;
      return {
        objectType,
        operation: "top",
        limit: Number(topMatch[1]),
        ...(field ? { field } : {}),
        filters: extractFilters(trimmed),
        connector: "rest-default",
      };
    }
  }

  /* Sum / Avg: "total pipeline value", "total amount of deals over $50k",
     "average deal size", "average amount of opportunities". */
  if (/\b(?:total|sum\s+of)\b/i.test(trimmed)) {
    const objectType = detectObject(trimmed) ?? "opportunity";
    return {
      objectType,
      operation: "sum",
      field: "Amount",
      filters: extractFilters(trimmed),
      connector: "rest-default",
    };
  }
  if (/\b(?:average|avg)\b/i.test(trimmed)) {
    const objectType = detectObject(trimmed) ?? "opportunity";
    return {
      objectType,
      operation: "avg",
      field: "Amount",
      filters: extractFilters(trimmed),
      connector: "rest-default",
    };
  }

  /* "pipeline value" / "pipeline size" → sum of Amount on open deals. */
  if (/\bpipeline\b/i.test(trimmed)) {
    return {
      objectType: "opportunity",
      operation: "sum",
      field: "Amount",
      filters: extractFilters(trimmed),
      connector: "rest-default",
    };
  }

  /* Count: "how many <objects>", "count of <objects>", "number of <objects>" */
  if (/\b(?:how\s+many|count\s+(?:of\s+)?|number\s+of)\b/i.test(trimmed)) {
    const objectType = detectObject(trimmed);
    if (objectType) {
      return {
        objectType,
        operation: "count",
        filters: extractFilters(trimmed),
        connector: "rest-default",
      };
    }
  }

  return null;
}

/* ---------------------------------------------------------------------
 * Rendering
 * ------------------------------------------------------------------- */

function describeFilters(f?: FilterSpec): string {
  if (!f) return "";
  const parts: string[] = [];
  if (f.amount) {
    const op = ({ gt: ">", lt: "<", gte: ">=", lte: "<=", eq: "=" } as const)[f.amount.op];
    parts.push(`amount ${op} $${f.amount.value.toLocaleString()}`);
  }
  if (f.dateRange) parts.push(f.dateRange.replace(/_/g, " "));
  if (f.stage) parts.push(`stage = "${f.stage}"`);
  if (f.ownerName) parts.push(`owned by ${f.ownerName}`);
  return parts.length > 0 ? ` (${parts.join(", ")})` : "";
}

function fmtCurrency(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}k`;
  return `$${n.toLocaleString()}`;
}

function renderAnswer(p: Params, result: AggregateResult): string {
  const filterDesc = describeFilters(p.filters);
  const label = p.objectType === "deal" || p.objectType === "opportunity" ? "deals" :
                p.objectType === "account" ? "accounts" : `${p.objectType}s`;
  if (p.operation === "count" && result.type === "scalar") {
    return `**${result.value ?? 0}** ${label}${filterDesc}.`;
  }
  if ((p.operation === "sum" || p.operation === "avg") && result.type === "scalar") {
    const verb = p.operation === "sum" ? "Total" : "Average";
    return `**${verb}**: ${fmtCurrency(result.value ?? 0)} across ${label}${filterDesc}.`;
  }
  if (p.operation === "win_rate" && result.type === "rate") {
    const num = result.numerator ?? 0;
    const denom = result.denominator ?? 0;
    if (denom === 0) return `No closed deals in the selected period${filterDesc} — win rate undefined.`;
    const pct = (num / denom) * 100;
    return `**Win rate: ${pct.toFixed(1)}%** (${num} won / ${denom} closed${filterDesc}).`;
  }
  if (p.operation === "top" && result.type === "list") {
    const rows = result.rows ?? [];
    if (rows.length === 0) return `No ${label}${filterDesc} to rank.`;
    const head = `**Top ${rows.length} ${label}**${filterDesc}:`;
    const list = rows
      .map((r, i) => {
        const name = (r.Name as string | undefined) ?? "(unnamed)";
        const id = (r.Id as string | undefined) ?? "?";
        const fieldName = p.field ?? "Amount";
        const v = r[fieldName];
        const formatted = typeof v === "number" ? fmtCurrency(v) : String(v ?? "?");
        return `${i + 1}. **${name}** \`${id}\` — ${fieldName}: ${formatted}`;
      })
      .join("\n");
    return `${head}\n\n${list}`;
  }
  return `Aggregate query returned an unexpected shape.`;
}

/* ---------------------------------------------------------------------
 * Tool definition
 * ------------------------------------------------------------------- */

export const aggregateExternalRecordsTool: ToolDef<Params, AggregateData> = {
  name: "aggregate_external_records",
  description:
    "Compute aggregate metrics over CRM records: counts, totals, averages, win rate, or top-N by field.",
  paramSchema: ParamSchema,
  capability: "*",
  matchIntent: matchAggregateIntent,
  async handler(params, ctx): Promise<ToolResult<AggregateData>> {
    let resolvedConnectorName = params.connector;
    if (params.connector === "rest-default") {
      const workspaceId = ctx.workspaceId || "default";
      const preferred = await pickConfiguredConnector(workspaceId);
      if (preferred && preferred !== "rest-default") resolvedConnectorName = preferred;
    }
    const connector = await buildRestConnectorForWorkspace(
      ctx.workspaceId || "default",
      resolvedConnectorName,
    );
    if (!connector.isConfigured()) {
      return {
        ok: true,
        data: {
          connector: resolvedConnectorName,
          objectType: params.objectType,
          operation: params.operation,
          result: { type: "scalar", value: 0 },
        },
        answer: `The "${resolvedConnectorName}" connector isn't configured. Connect Salesforce from /admin/connectors first.`,
      };
    }
    if (typeof connector.searchAggregate !== "function") {
      return {
        ok: false,
        code: "internal",
        message: `connector "${resolvedConnectorName}" does not support aggregate queries`,
      };
    }
    const spec: AggregateSpec = {
      objectType: params.objectType,
      operation: params.operation,
      ...(params.field ? { field: params.field } : {}),
      ...(params.limit ? { limit: params.limit } : {}),
      ...(params.filters ? { filters: params.filters } : {}),
    };
    const result = await connector.searchAggregate(spec);
    if (!result.ok) {
      return {
        ok: false,
        code: result.code === "auth_failed" ? "capability" : "internal",
        message: result.message ?? "aggregate query failed",
      };
    }
    trackEvent("assistant.connector_aggregate_executed", ctx.userId, ctx.userRole, {
      connector: resolvedConnectorName,
      object_type: params.objectType,
      operation: params.operation,
      result_type: result.data?.type ?? "unknown",
    });
    return {
      ok: true,
      data: {
        connector: resolvedConnectorName,
        objectType: params.objectType,
        operation: params.operation,
        result: result.data ?? { type: "scalar", value: 0 },
      },
      answer: withSourceFooter(
        renderAnswer(params, result.data ?? { type: "scalar", value: 0 }),
        resolvedConnectorName,
      ),
    };
  },
};

registerTool(aggregateExternalRecordsTool);
