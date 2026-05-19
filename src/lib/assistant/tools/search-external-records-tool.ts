/**
 * search_external_records — free-text search across CRM records.
 *
 * Why this exists separately from get_external_record:
 *   - get_external_record needs an exact ID (003abc, 001xyz). Real
 *     users don't know SF IDs.
 *   - This tool takes a name, an email, or a fragment ("McDonald's",
 *     "grimace@", "ACME Industries") and asks the connector to find
 *     matching records. Salesforce gets SOQL, HubSpot gets the search
 *     endpoint, etc — all vendor-specific paths live in
 *     vendor-presets.ts so the tool stays generic.
 *
 * Intent patterns:
 *   "look up Grimace Fromcdonalds"     → name search across contacts
 *   "find grimace@mcdonalds.com"       → email search
 *   "search for McDonald's"            → free-text
 *   "find the contact for Grimace"     → typed object + name
 *
 * Note: "who is X" is owned by who_is (team-first, CRM-fallback).
 * If you add it back here, the chat will surface "no contact match
 * in the CRM" for every literal teammate — which was the original
 * bug. Don't.
 *
 * Disambiguation: 0 results → "no match", 1 result → full render,
 * 2–5 results → numbered list so user can refine, >5 → top 5 + count.
 */

import { z } from "zod";
import {
  buildRestConnectorForWorkspace,
  getConnector,
  pickConfiguredConnector,
} from "@/lib/assistant/connectors";
import type { Connector } from "@/lib/assistant/connectors";
import { trackEvent } from "@/lib/analytics";
import { registerTool } from "./registry";
import type { ToolDef, ToolResult } from "./types";
import { withSourceFooter } from "./source-footer";
import { maybePortalSource } from "./portal-link";
import type { AssistantSourceRef } from "@/lib/assistant";

const OBJECT_TYPES = ["contact", "deal", "company", "account"] as const;
type ObjectType = (typeof OBJECT_TYPES)[number];

const ParamSchema = z.object({
  objectType: z.enum(OBJECT_TYPES).default("contact"),
  query: z.string().min(2).max(200),
  connector: z.string().min(1).max(40).default("rest-default"),
});
type Params = z.infer<typeof ParamSchema>;

interface SearchExternalRecordsData {
  connector: string;
  objectType: string;
  query: string;
  matchCount: number;
  records: Array<Record<string, unknown>>;
}

/* ---------------------------------------------------------------------
 * Intent matching
 * ---------------------------------------------------------------------
 * Patterns try to extract (optional objectType, query). Stopwords like
 * "in salesforce", "in our CRM" get stripped from the query. Patterns
 * are ordered so the most specific runs first — typed-object patterns
 * before generic verbs, generic verbs before "who is".
 *
 * Critical: every regex must FAIL to match an ID-lookup phrase (those
 * belong to get_external_record). We do that by requiring multi-word
 * captures OR an "@" sign, and rejecting captures that look like an
 * 18-char SF ID.
 * ------------------------------------------------------------------- */

const STOPWORDS = /\s+(?:in\s+(?:our\s+)?(?:crm|salesforce|sf|hubspot)|please)\s*$/i;
const SF_ID_RE = /^[a-zA-Z0-9]{15,18}$/;

function cleanQuery(raw: string): string {
  return raw.trim().replace(STOPWORDS, "").replace(/[?.!,]+$/g, "").trim();
}

/** True when the captured string looks like the wrong target for THIS
 *  tool (it's either an ID or an empty fragment). The get_external_record
 *  tool handles those. */
function looksLikeIdNotName(q: string): boolean {
  if (!q || q.length < 2) return true;
  if (SF_ID_RE.test(q)) return true;
  /* Explicit "id <something>" — the user is reaching for the ID-lookup
     tool, not the search tool. Drop through. */
  if (/^id\s+/i.test(q)) return true;
  /* "with id <something>" / "record for <something>" — same intent. */
  if (/^(?:with\s+id\s+|record\s+for\s+)/i.test(q)) return true;
  /* "<object-type> id <something>" — the generic "look up <free-text>"
     pattern can capture this when the inner regex isn't strict enough.
     We catch it here as a safety net so get_external_record gets the
     phrase. */
  if (/^(?:contacts?|people|person|deals?|opportunit(?:y|ies)|accounts?|compan(?:y|ies)|invoices?|payments?|tickets?)\s+id\s+/i.test(q))
    return true;
  /* Single-word ALL-CAPS short alphanumeric without spaces — likely an
     external ID, not a person name. "ACME" or "INV-001" passes through
     to get_external_record. */
  if (!q.includes(" ") && !q.includes("@") && /^[A-Z0-9_-]{3,12}$/.test(q)) return true;
  return false;
}

const OBJECT_ALIAS: Record<string, ObjectType> = {
  contact: "contact",
  contacts: "contact",
  person: "contact",
  people: "contact",
  deal: "deal",
  deals: "deal",
  opportunity: "deal",
  opportunities: "deal",
  account: "account",
  accounts: "account",
  company: "company",
  companies: "company",
};

const PATTERNS: Array<{ re: RegExp; build(m: RegExpExecArray): Partial<Params> | null }> = [
  {
    /* Typed object: "find the contact for Grimace", "search for the account
       called Acme", "look up contact Grimace Fromcdonalds". */
    re: /\b(?:look\s+up|find|search\s+for|fetch|pull|show\s+(?:me\s+)?(?:the\s+)?)(?:\s+the)?\s+(contacts?|people|person|deals?|opportunit(?:y|ies)|accounts?|compan(?:y|ies))(?:\s+(?:for|called|named|with\s+name))?\s+(.{2,160})$/i,
    build: (m) => {
      const ot = OBJECT_ALIAS[m[1].toLowerCase()];
      const q = cleanQuery(m[2]);
      if (!ot || looksLikeIdNotName(q)) return null;
      return { objectType: ot, query: q };
    },
  },
  {
    /* Email search: "find grimace@mcdonalds.com", "look up someone with
       email user@host". Always defaults to contact. */
    re: /\b(?:find|look\s+up|search\s+(?:for\s+)?|who\s+(?:is|owns))\s+(?:someone\s+with\s+email\s+)?([\w.+-]+@[\w-]+(?:\.[\w-]+)+)/i,
    build: (m) => ({ objectType: "contact", query: cleanQuery(m[1]) }),
  },
  /* Removed (2026-05-19): "Generic look up <free-text> / find
     <free-text> WITHOUT an object type" used to land here and route
     every bare-search phrasing straight to the CRM. That shadowed
     Universal Search — the user expected "search Acme" / "look up
     Acme" to fan out across chats, emails, calendar, knowledge, AND
     the CRM at once. The Universal Search `search` tool now owns
     bare-search phrasings and its `crm` provider re-fans them into
     the CRM, so a single "search Acme" hits every surface. The
     typed-object pattern above STILL claims "find the contact for X"
     / "look up account X" because those carry object-type
     disambiguation that the per-object renderer here handles better
     than Universal Search's interleaved result list. */
  /* Removed earlier: "who is <name>" used to land here and surface
     "No contact matches found in the configured CRM" for every
     literal teammate. The who_is tool now owns that intent and
     falls back to CRM internally on team-roster miss. */
];

function matchSearchIntent(message: string): Params | null {
  const trimmed = message.trim();
  for (const { re, build } of PATTERNS) {
    const m = re.exec(trimmed);
    if (!m) continue;
    const built = build(m);
    if (!built || !built.query) continue;
    return {
      objectType: built.objectType ?? "contact",
      query: built.query,
      connector: built.connector ?? "rest-default",
    };
  }
  return null;
}

/* ---------------------------------------------------------------------
 * Render — turn a search result list into a Markdown answer
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
  const name = valueOf(record, "Name", "name", "fullName", "FullName") ?? "(unnamed)";
  const id = valueOf(record, "Id", "id") ?? "?";
  const extras: string[] = [];
  if (objectType === "contact") {
    const email = valueOf(record, "Email", "email", "primaryEmail");
    const account =
      valueOf(record, "Account.Name") ??
      (record["Account"] as { Name?: string } | undefined)?.Name;
    if (email) extras.push(email);
    if (account) extras.push(`@ ${account}`);
  } else if (objectType === "deal") {
    const stage = valueOf(record, "StageName", "stage");
    const amount = valueOf(record, "Amount", "amount");
    if (stage) extras.push(stage);
    if (amount) extras.push(`$${amount}`);
  } else if (objectType === "company" || objectType === "account") {
    const industry = valueOf(record, "Industry", "industry");
    const phone = valueOf(record, "Phone", "phone");
    if (industry) extras.push(industry);
    if (phone) extras.push(phone);
  }
  const tail = extras.length > 0 ? ` — ${extras.join(" · ")}` : "";
  return `**${name}** \`${id}\`${tail}`;
}

function renderFullRecord(record: Record<string, unknown>, objectType: string): string {
  const lines: string[] = [];
  lines.push(renderOneLine(record, objectType));
  const id = valueOf(record, "Id", "id");
  if (id) {
    lines.push("");
    lines.push("Use `look up " + objectType + " id " + id + "` to fetch the full record.");
  }
  return lines.join("\n");
}

function renderAnswer(
  query: string,
  objectType: string,
  records: Array<Record<string, unknown>>,
): string {
  if (records.length === 0) {
    return `No ${objectType} matches found for "${query}" in the configured CRM.`;
  }
  if (records.length === 1) {
    const label = objectType.charAt(0).toUpperCase() + objectType.slice(1);
    return `Found 1 ${label} matching "${query}":\n\n${renderFullRecord(records[0], objectType)}`;
  }
  const top = records.slice(0, 5);
  const head =
    records.length > 5
      ? `Found ${records.length}+ ${objectType}s matching "${query}". Top 5:`
      : `Found ${records.length} ${objectType}s matching "${query}":`;
  const list = top
    .map((r, i) => `${i + 1}. ${renderOneLine(r, objectType)}`)
    .join("\n");
  return `${head}\n\n${list}\n\nReply with the number or paste the ID to drill in.`;
}

/* ---------------------------------------------------------------------
 * Tool definition
 * ------------------------------------------------------------------- */

export const searchExternalRecordsTool: ToolDef<Params, SearchExternalRecordsData> = {
  name: "search_external_records",
  description:
    "Search records (contacts, deals, accounts, companies) by name, email, or free-text in the configured CRM.",
  paramSchema: ParamSchema,
  capability: "*",
  matchIntent: matchSearchIntent,
  async handler(params, ctx): Promise<ToolResult<SearchExternalRecordsData>> {
    /* Same auto-routing as get_external_record: pick the workspace's
       configured vendor connector when caller didn't name one. */
    let connector: Connector | null = null;
    let resolvedConnectorName = params.connector;
    if (params.connector === "rest-default") {
      const workspaceId = ctx.workspaceId || "default";
      const preferred = await pickConfiguredConnector(workspaceId);
      if (preferred && preferred !== "rest-default") {
        resolvedConnectorName = preferred;
      }
      connector = await buildRestConnectorForWorkspace(workspaceId, resolvedConnectorName);
    } else {
      connector = getConnector(params.connector);
    }
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
          query: params.query,
          matchCount: 0,
          records: [],
        },
        answer: `The "${resolvedConnectorName}" connector isn't configured yet. Connect Salesforce or HubSpot from /admin/connectors first.`,
      };
    }
    const result = await connector.searchRecords(params.objectType, params.query, 10);
    if (!result.ok) {
      return {
        ok: false,
        code: result.code === "auth_failed" ? "capability" : "internal",
        message:
          (result.message ?? "external search failed") +
          ` (connector=${resolvedConnectorName}, took ${result.durationMs ?? 0}ms)`,
      };
    }
    const records = result.data ?? [];
    /* Search-recall telemetry. The learning loop watches match_count=0
       trends — a sudden spike often signals an auth break, a SF API
       version bump, or a regex regression that's eating queries. */
    trackEvent("assistant.connector_search_executed", ctx.userId, ctx.userRole, {
      connector: resolvedConnectorName,
      object_type: params.objectType,
      query_length: params.query.length,
      match_count: records.length,
    });
    /* Salesforce matches get "Open in Wolfpack portal" source chips so
       users can drop straight into the portal drill-in. Top 5 matches
       at most (matches the rendered list); we'd flood the chip strip
       otherwise. Non-Salesforce connectors get an empty source list
       (portal is Salesforce-only in the MVP). */
    const portalSources: AssistantSourceRef[] = [];
    if (resolvedConnectorName === "salesforce") {
      for (const r of records.slice(0, 5)) {
        const id = typeof r.Id === "string" ? r.Id : typeof r.id === "string" ? r.id : "";
        const source = maybePortalSource({
          connectorName: resolvedConnectorName,
          objectType: params.objectType,
          id,
        });
        if (source) {
          /* Title the chip with the record name (when present) so the
             user can tell which one they're clicking into. */
          const name = typeof r.Name === "string" ? r.Name : null;
          portalSources.push(name ? { ...source, title: `${name} — open in portal` } : source);
        }
      }
    }
    return {
      ok: true,
      data: {
        connector: resolvedConnectorName,
        objectType: params.objectType,
        query: params.query,
        matchCount: records.length,
        records,
      },
      answer: withSourceFooter(
        renderAnswer(params.query, params.objectType, records),
        resolvedConnectorName,
      ),
      sources: portalSources.length > 0 ? portalSources : undefined,
    };
  },
};

registerTool(searchExternalRecordsTool);
