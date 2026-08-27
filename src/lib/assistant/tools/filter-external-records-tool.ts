/**
 * filter_external_records — "deals over $50k closing this month"
 *
 * Regex-driven filter parser (no LLM-generated SOQL today) extracts:
 *   - amount thresholds: "over $50k", "under 10000", "above $1m"
 *   - date ranges: "closing this month", "closed last week"
 *   - stage filters: "stuck in Proposal", "in Closed Won"
 *   - owner filters: "Jorge owns" / "owned by Jorge"
 *
 * The structured FilterSpec then hits connector.searchFiltered which
 * the vendor preset translates to the native filter expression (SOQL
 * WHERE for Salesforce; future: HubSpot search filter body).
 *
 * Safe-by-design: only the clauses we have regexes for can fire. The
 * SOQL ORDER BY + LIMIT are fixed by the preset. There's no path for
 * user input to inject arbitrary SOQL.
 */

import { z } from "zod";
import { trackEvent } from "@/lib/analytics";
import { registerTool } from "./registry";
import { resolveScopedConnector } from "./resolve-connector";
import type { ToolDef, ToolResult } from "./types";
import type { FilterSpec } from "@/lib/assistant/connectors/vendor-presets";
import { withSourceFooter } from "./source-footer";

const OBJECT_TYPES = ["contact", "deal", "opportunity", "account"] as const;
type ObjectType = (typeof OBJECT_TYPES)[number];

const ParamSchema = z.object({
  objectType: z.enum(OBJECT_TYPES),
  filters: z.object({
    amount: z
      .object({
        op: z.enum(["gt", "lt", "gte", "lte", "eq"]),
        value: z.number(),
      })
      .optional(),
    dateRange: z
      .enum([
        "this_week",
        "last_week",
        "this_month",
        "last_month",
        "next_month",
        "this_quarter",
        "this_year",
      ])
      .optional(),
    stage: z.string().min(1).max(40).optional(),
    ownerName: z.string().min(2).max(80).optional(),
  }),
  connector: z.string().min(1).max(40).default("rest-default"),
});
type Params = z.infer<typeof ParamSchema>;

interface FilterRecordsData {
  connector: string;
  objectType: string;
  filters: FilterSpec;
  matchCount: number;
  records: Array<Record<string, unknown>>;
}

/* ---------------------------------------------------------------------
 * Filter clause extractors
 * ------------------------------------------------------------------- */

const OBJECT_ALIAS: Record<string, ObjectType> = {
  contact: "contact",
  contacts: "contact",
  deal: "deal",
  deals: "deal",
  opportunity: "opportunity",
  opportunities: "opportunity",
  account: "account",
  accounts: "account",
  company: "account",
  companies: "account",
};

/** "$50k" / "50000" / "$1m" / "1,000,000" → number. */
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

  /* Amount: "over $50k" / "above 100k" / "under $10k" / ">= $50000" */
  const amountMatch = /\b(over|above|more\s+than|greater\s+than|>=?|under|below|less\s+than|<=?)\s+(\$?[\d,]+(?:\.\d+)?(?:\s*[kKmM])?)/i.exec(
    msg,
  );
  if (amountMatch) {
    const word = amountMatch[1].toLowerCase().replace(/\s+/g, " ");
    const opMap: Record<string, FilterSpec["amount"] extends infer X ? (X extends { op: infer Op } ? Op : never) : never> = {
      over: "gt",
      above: "gt",
      "more than": "gt",
      "greater than": "gt",
      ">": "gt",
      ">=": "gte",
      under: "lt",
      below: "lt",
      "less than": "lt",
      "<": "lt",
      "<=": "lte",
    };
    const op = opMap[word];
    const val = parseAmount(amountMatch[2]);
    if (op && val !== null) f.amount = { op, value: val };
  }

  /* Date range. Detect the symbol; the preset translates to the SOQL
     literal (THIS_MONTH, LAST_WEEK, etc.). */
  if (/\b(this\s+month|in\s+this\s+month|closing\s+this\s+month|due\s+this\s+month)\b/i.test(msg)) f.dateRange = "this_month";
  else if (/\b(last\s+month|in\s+last\s+month|closed\s+last\s+month)\b/i.test(msg)) f.dateRange = "last_month";
  else if (/\b(next\s+month|closing\s+next\s+month)\b/i.test(msg)) f.dateRange = "next_month";
  else if (/\b(this\s+week|closing\s+this\s+week|due\s+this\s+week)\b/i.test(msg)) f.dateRange = "this_week";
  else if (/\b(last\s+week|closed\s+last\s+week)\b/i.test(msg)) f.dateRange = "last_week";
  else if (/\b(this\s+quarter|in\s+this\s+quarter)\b/i.test(msg)) f.dateRange = "this_quarter";
  else if (/\b(this\s+year|in\s+this\s+year)\b/i.test(msg)) f.dateRange = "this_year";

  /* Stage filter. "in stage Proposal" / "stuck in Proposal" / "in Closed Won" */
  const stageMatch =
    /\b(?:stuck\s+)?in\s+(?:stage\s+)?(Closed\s+Won|Closed\s+Lost|Discovery|Proposal|Negotiation|Qualification|Prospecting|Needs\s+Analysis|Value\s+Proposition|Id\.\s+Decision\s+Makers|Perception\s+Analysis|Proposal\/Price\s+Quote|Negotiation\/Review)\b/i.exec(
      msg,
    );
  if (stageMatch) f.stage = stageMatch[1].trim();

  /* Owner filter. "owned by Jorge" / "Jorge owns" / "deals owned by Jorge" */
  const ownerMatch =
    /\bowned\s+by\s+([A-Z][\w'.-]+(?:\s+[A-Z][\w'.-]+)?)/i.exec(msg) ??
    /\b([A-Z][\w'.-]+(?:\s+[A-Z][\w'.-]+)?)\s+owns\b/.exec(msg);
  if (ownerMatch) f.ownerName = ownerMatch[1].trim();

  return f;
}

/* ---------------------------------------------------------------------
 * Intent matching
 * ------------------------------------------------------------------- */

/**
 * Telling the assistant something is not asking it something.
 *
 * "owns" is a filter signal below, because "deals owned by Jorge" is a real
 * CRM query. It also appears in the plainest way anybody states an org fact:
 * "remember that Jorge owns the Porsche account". That sentence reached this
 * tool, which read it as a query and answered confidently about the wrong
 * thing, while the fact went unsaved.
 *
 * A leading imperative to remember settles it without weakening the filter for
 * any question. */
const TEACHING_RE = /^\s*(?:please\s+)?(?:remember|save|store|note|record)\b/i;

function matchFilterIntent(message: string): Params | null {
  const trimmed = message.trim();
  if (TEACHING_RE.test(trimmed)) return null;
  /* Must contain at least one filter signal AND name an object type.
     This keeps the tool from claiming "find Grimace" (no filter
     signal) or "deals" alone (no filter signal). */
  const hasFilterSignal =
    /\b(over|above|under|below|more\s+than|less\s+than|>=?|<=?)\s+\$?\d/i.test(trimmed) ||
    /\b(this\s+week|last\s+week|this\s+month|last\s+month|next\s+month|this\s+quarter|this\s+year|closing|closed\s+last|due\s+this)\b/i.test(trimmed) ||
    /\b(stuck\s+in|in\s+stage|in\s+closed\s+won|in\s+closed\s+lost|in\s+proposal|in\s+discovery|in\s+negotiation)\b/i.test(trimmed) ||
    /\b(owned\s+by|owns)\b/i.test(trimmed);

  if (!hasFilterSignal) return null;

  /* Find an object-type noun in the message. */
  const objectMatch = /\b(deals?|opportunit(?:y|ies)|contacts?|accounts?|compan(?:y|ies))\b/i.exec(trimmed);
  if (!objectMatch) return null;
  const objectType = OBJECT_ALIAS[objectMatch[1].toLowerCase()];
  if (!objectType) return null;

  const filters = extractFilters(trimmed);
  /* Require at least one parsed filter clause — otherwise the tool's
     "find <object> matching <filter>" semantics doesn't apply. */
  if (
    !filters.amount &&
    !filters.dateRange &&
    !filters.stage &&
    !filters.ownerName
  ) return null;

  return { objectType, filters, connector: "rest-default" };
}

/* ---------------------------------------------------------------------
 * Rendering
 * ------------------------------------------------------------------- */

function valueOf(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = record[k];
    if (typeof v === "string" && v.trim()) return v;
    if (typeof v === "number") return String(v);
  }
  return undefined;
}

function renderOneLine(record: Record<string, unknown>, objectType: string): string {
  const name = valueOf(record, "Name", "name") ?? "(unnamed)";
  const id = valueOf(record, "Id", "id") ?? "?";
  const extras: string[] = [];
  if (objectType === "deal" || objectType === "opportunity") {
    const stage = valueOf(record, "StageName");
    const amount = valueOf(record, "Amount");
    const close = valueOf(record, "CloseDate");
    if (stage) extras.push(stage);
    if (amount) extras.push(`$${amount}`);
    if (close) extras.push(`close ${close}`);
  } else if (objectType === "contact") {
    const email = valueOf(record, "Email");
    if (email) extras.push(email);
  }
  const tail = extras.length > 0 ? ` — ${extras.join(" · ")}` : "";
  return `**${name}** \`${id}\`${tail}`;
}

function describeFilters(f: FilterSpec): string {
  const parts: string[] = [];
  if (f.amount) {
    const opLabel: Record<NonNullable<FilterSpec["amount"]>["op"], string> = {
      gt: ">",
      lt: "<",
      gte: ">=",
      lte: "<=",
      eq: "=",
    };
    parts.push(`amount ${opLabel[f.amount.op]} $${f.amount.value.toLocaleString()}`);
  }
  if (f.dateRange) parts.push(f.dateRange.replace(/_/g, " "));
  if (f.stage) parts.push(`stage = "${f.stage}"`);
  if (f.ownerName) parts.push(`owner like "${f.ownerName}"`);
  return parts.join(", ");
}

function renderAnswer(p: Params, records: Array<Record<string, unknown>>): string {
  const filterDesc = describeFilters(p.filters);
  if (records.length === 0) {
    return `No ${p.objectType}s matched (${filterDesc}).`;
  }
  const top = records.slice(0, 10);
  const head =
    records.length > 10
      ? `${records.length}+ ${p.objectType}s matching ${filterDesc}. Top 10:`
      : `${records.length} ${p.objectType}${records.length === 1 ? "" : "s"} matching ${filterDesc}:`;
  const list = top.map((r, i) => `${i + 1}. ${renderOneLine(r, p.objectType)}`).join("\n");
  return `${head}\n\n${list}`;
}

/* ---------------------------------------------------------------------
 * Tool definition
 * ------------------------------------------------------------------- */

export const filterExternalRecordsTool: ToolDef<Params, FilterRecordsData> = {
  name: "filter_external_records",
  description:
    "Filter CRM records by amount, date range, stage, or owner (deals over $50k closing this month, stuck in Proposal, etc).",
  paramSchema: ParamSchema,
  capability: "*",
  matchIntent: matchFilterIntent,
  async handler(params, ctx): Promise<ToolResult<FilterRecordsData>> {
    const resolved = await resolveScopedConnector(ctx, params.connector);
    if (!resolved.ok) return resolved.failure;
    const resolvedConnectorName = resolved.resolvedConnectorName;
    const connector = resolved.connector;
    if (!connector) {
      return {
        ok: false,
        code: "internal",
        message: `connector "${params.connector}" not registered`,
      };
    }
    if (!connector.isConfigured()) {
      return {
        ok: true,
        data: {
          connector: resolvedConnectorName,
          objectType: params.objectType,
          filters: params.filters,
          matchCount: 0,
          records: [],
        },
        answer: `The "${resolvedConnectorName}" connector isn't configured. Connect Salesforce from /admin/connectors first.`,
      };
    }
    if (typeof connector.searchFiltered !== "function") {
      return {
        ok: false,
        code: "internal",
        message: `connector "${resolvedConnectorName}" does not support filter queries`,
      };
    }
    const result = await connector.searchFiltered(params.objectType, params.filters, 10);
    if (!result.ok) {
      return {
        ok: false,
        code: result.code === "auth_failed" ? "capability" : "internal",
        message: result.message ?? "filter lookup failed",
      };
    }
    const records = result.data ?? [];
    trackEvent("assistant.connector_filter_executed", ctx.userId, ctx.userRole, {
      connector: resolvedConnectorName,
      object_type: params.objectType,
      has_amount: !!params.filters.amount,
      has_date: !!params.filters.dateRange,
      has_stage: !!params.filters.stage,
      has_owner: !!params.filters.ownerName,
      match_count: records.length,
    });
    return {
      ok: true,
      data: {
        connector: resolvedConnectorName,
        objectType: params.objectType,
        filters: params.filters,
        matchCount: records.length,
        records,
      },
      answer: withSourceFooter(renderAnswer(params, records), resolvedConnectorName),
    };
  },
};

registerTool(filterExternalRecordsTool);
