/**
 * get_related_records — "Acme's open opportunities" / "Jorge's deals"
 *
 * Routes to connector.searchRelated which composes the vendor-specific
 * relationship SOQL (Salesforce: WHERE Account.Name LIKE '%X%' or
 * WHERE Owner.Name LIKE '%X%' depending on the parent type).
 *
 * Why a separate tool from search_external_records: the search tool
 * resolves "find Grimace" against a single object's name field; the
 * relationship case needs a JOIN-style query the connector has a
 * different SOQL builder for. Splitting keeps each tool's intent
 * regex tight + the analytics events distinct.
 */

import { z } from "zod";
import { trackEvent } from "@/lib/analytics";
import { registerTool } from "./registry";
import { resolveScopedConnector } from "./resolve-connector";
import type { ToolDef, ToolResult } from "./types";
import { withSourceFooter } from "./source-footer";

const PARENT_TYPES = ["account", "company", "contact"] as const;
const RELATED_TYPES = ["opportunity", "deal", "contact", "account", "task"] as const;

const ParamSchema = z.object({
  parentType: z.enum(PARENT_TYPES),
  parentName: z.string().min(2).max(160),
  relatedType: z.enum(RELATED_TYPES),
  connector: z.string().min(1).max(40).default("rest-default"),
});
type Params = z.infer<typeof ParamSchema>;

interface RelatedRecordsData {
  connector: string;
  parentType: string;
  parentName: string;
  relatedType: string;
  matchCount: number;
  records: Array<Record<string, unknown>>;
}

const RELATED_ALIAS: Record<string, (typeof RELATED_TYPES)[number]> = {
  opportunity: "opportunity",
  opportunities: "opportunity",
  deal: "deal",
  deals: "deal",
  contact: "contact",
  contacts: "contact",
  person: "contact",
  people: "contact",
  account: "account",
  accounts: "account",
  task: "task",
  tasks: "task",
  activity: "task",
  activities: "task",
};

/* ---------------------------------------------------------------------
 * Intent matching
 *
 * Three phrasings:
 *   1. "<X>'s <objects>"   → possessive
 *   2. "<objects> for <X>" → "for"
 *   3. "<objects> that <X> owns" / "what <objects> does <X> own"
 *      → owner-based
 *
 * The parent name + related type are captured; the parentType is
 * inferred from the verb context (owner-based → contact; account
 * grammar → account).
 * ------------------------------------------------------------------- */

const PATTERNS: Array<{ re: RegExp; build(m: RegExpExecArray): Partial<Params> | null }> = [
  {
    /* Possessive: "Acme's opportunities" / "Jorge's deals" */
    re: /\b(?:show\s+(?:me\s+)?)?(?:what\s+(?:are\s+|is\s+)?)?(?:the\s+)?([A-Z][\w'.-]+(?:\s+[A-Z][\w'.-]+)*)(?:'s|s')\s+(?:open\s+|active\s+|recent\s+)?(\w+)\b/i,
    build: (m) => {
      const parent = m[1].trim();
      const related = RELATED_ALIAS[m[2].toLowerCase()];
      if (!related) return null;
      /* Infer parentType: if the related is opportunity/deal/contact and
         the parent name is multi-word capital, default to account. If
         single-word and feels like a first name (no spaces), default to
         contact (owner). User can override if wrong. */
      const inferred = parent.includes(" ") ? "account" : "contact";
      return { parentType: inferred, parentName: parent, relatedType: related };
    },
  },
  {
    /* "what <objects> does <X> own" / "what deals does Jorge own" */
    re: /\bwhat\s+(\w+)\s+does\s+([A-Z][\w'.-]+(?:\s+[A-Z][\w'.-]+)*)\s+own\b/i,
    build: (m) => {
      const related = RELATED_ALIAS[m[1].toLowerCase()];
      if (!related) return null;
      return { parentType: "contact", parentName: m[2].trim(), relatedType: related };
    },
  },
  {
    /* "show me <objects> for <X>" / "<objects> for <X>" */
    re: /\b(?:show\s+(?:me\s+)?|list\s+|find\s+)?(\w+)\s+for\s+(?:the\s+)?([A-Z][\w'.-]+(?:\s+[A-Z][\w'.-]+)*)$/i,
    build: (m) => {
      const related = RELATED_ALIAS[m[1].toLowerCase()];
      if (!related) return null;
      /* "for X" with multi-word X likely means an Account; single-word
         likely a person/contact. */
      const parent = m[2].trim();
      const inferred = parent.includes(" ") ? "account" : "contact";
      return { parentType: inferred, parentName: parent, relatedType: related };
    },
  },
];

function matchRelatedIntent(message: string): Params | null {
  const trimmed = message.trim();
  for (const { re, build } of PATTERNS) {
    const m = re.exec(trimmed);
    if (!m) continue;
    const built = build(m);
    if (!built || !built.parentType || !built.parentName || !built.relatedType) continue;
    if (built.parentName.length < 2) continue;
    return {
      parentType: built.parentType,
      parentName: built.parentName,
      relatedType: built.relatedType,
      connector: "rest-default",
    };
  }
  return null;
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

function renderOneLine(record: Record<string, unknown>, relatedType: string): string {
  const name = valueOf(record, "Name", "name") ?? "(unnamed)";
  const extras: string[] = [];
  if (relatedType === "opportunity" || relatedType === "deal") {
    const stage = valueOf(record, "StageName");
    const amount = valueOf(record, "Amount");
    if (stage) extras.push(stage);
    if (amount) extras.push(`$${amount}`);
  } else if (relatedType === "contact") {
    const email = valueOf(record, "Email");
    if (email) extras.push(email);
  }
  const tail = extras.length > 0 ? ` — ${extras.join(" · ")}` : "";
  /* Salesforce record IDs go into the sources array for the citation
   *  surface; they don't belong inline in the user-facing answer. */
  return `**${name}**${tail}`;
}

/* Irregular plurals — naive `+ "s"` produces "opportunitys",
 *  "companys", "personss". Map known relatedTypes to their proper
 *  English plural. */
const PLURAL_FORM: Record<string, string> = {
  opportunity: "opportunities",
  deal: "deals",
  contact: "contacts",
  account: "accounts",
  task: "tasks",
  company: "companies",
};

function pluralize(relatedType: string): string {
  return PLURAL_FORM[relatedType] ?? `${relatedType}s`;
}

function renderAnswer(p: Params, records: Array<Record<string, unknown>>): string {
  const label = p.relatedType.charAt(0).toUpperCase() + p.relatedType.slice(1);
  if (records.length === 0) {
    return `No ${pluralize(p.relatedType)} found for ${p.parentName} in the configured CRM.`;
  }
  const top = records.slice(0, 10);
  const head =
    records.length > 10
      ? `${records.length}+ ${label} records related to ${p.parentName}. Top 10:`
      : `${records.length} ${label} record${records.length === 1 ? "" : "s"} for ${p.parentName}:`;
  const list = top.map((r, i) => `${i + 1}. ${renderOneLine(r, p.relatedType)}`).join("\n");
  return `${head}\n\n${list}`;
}

/* ---------------------------------------------------------------------
 * Tool definition
 * ------------------------------------------------------------------- */

export const getRelatedRecordsTool: ToolDef<Params, RelatedRecordsData> = {
  name: "get_related_records",
  description:
    /* NO REAL NAMES IN A DESCRIPTION A CLIENT READS. This said "Acme's
       opportunities, Jorge's deals, contacts for Acme". Jorge is a colleague,
       and he was the only person named anywhere in the catalog, so the line
       read as the product having been built around one company's staff rather
       than as an example. A client seeing somebody else's employee in a
       capability list reasonably wonders whose data is in there. Phrased by
       ROLE instead, which is also clearer about what the tool matches. */
    "Find records related to a person or company: an account's open opportunities, a rep's deals, the contacts at a company.",
  paramSchema: ParamSchema,
  capability: "*",
  matchIntent: matchRelatedIntent,
  async handler(params, ctx): Promise<ToolResult<RelatedRecordsData>> {
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
          parentType: params.parentType,
          parentName: params.parentName,
          relatedType: params.relatedType,
          matchCount: 0,
          records: [],
        },
        answer: `The "${resolvedConnectorName}" connector isn't configured. Connect Salesforce from /admin/connectors first.`,
      };
    }
    if (typeof connector.searchRelated !== "function") {
      return {
        ok: false,
        code: "internal",
        message: `connector "${resolvedConnectorName}" does not support related-record search`,
      };
    }
    const result = await connector.searchRelated(
      params.parentType,
      params.parentName,
      params.relatedType,
      10,
    );
    if (!result.ok) {
      return {
        ok: false,
        code: result.code === "auth_failed" ? "capability" : "internal",
        message: result.message ?? "related lookup failed",
      };
    }
    const records = result.data ?? [];
    trackEvent("assistant.connector_related_executed", ctx.userId, ctx.userRole, {
      connector: resolvedConnectorName,
      parent_type: params.parentType,
      related_type: params.relatedType,
      match_count: records.length,
    });
    return {
      ok: true,
      data: {
        connector: resolvedConnectorName,
        parentType: params.parentType,
        parentName: params.parentName,
        relatedType: params.relatedType,
        matchCount: records.length,
        records,
      },
      answer: withSourceFooter(renderAnswer(params, records), resolvedConnectorName),
    };
  },
};

registerTool(getRelatedRecordsTool);
