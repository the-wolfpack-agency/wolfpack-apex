/**
 * update_external_record tool — Phase-3 action tool for mutating
 * existing CRM records by single-field updates.
 *
 * Two phrasings:
 *   1. "move <object> <name> to (stage|closed won)" — the most common
 *      sales motion. Maps to a Salesforce Opportunity StageName update.
 *   2. "update <object> <name>'s <field> to <value>" — generic single-
 *      field update. Maps to a PATCH with one field.
 *   3. "set <object> <name> <field>=<value>" — same.
 *
 * In ALL cases the tool first NEEDS the record id. Phase-1 ship of
 * this tool resolves the id by a name search before the PATCH fires —
 * if the search returns 0 or >1 matches, the tool refuses and asks
 * the user to disambiguate. That keeps writes safe.
 *
 * Same Phase-3 confirmation contract as create_external_record:
 * handler returns the "Will set X.Y = Z / Confirm?" preview; user
 * confirms; chat() calls executeUpdateExternalRecord(...).
 */

import { z } from "zod";
import {
  buildRestConnectorForWorkspace,
  pickConfiguredConnector,
} from "@/lib/assistant/connectors";
import { trackEvent } from "@/lib/analytics";
import { registerTool } from "./registry";
import type { ToolDef, ToolResult } from "./types";

const OBJECT_TYPES = ["contact", "deal", "account", "opportunity"] as const;
type ObjectType = (typeof OBJECT_TYPES)[number];

const ParamSchema = z.object({
  objectType: z.enum(OBJECT_TYPES),
  /** Name (or unique fragment) of the record to update. The executor
   *  resolves this to an id via the connector's searchRecords before
   *  the PATCH fires. */
  recordName: z.string().min(2).max(160),
  fieldName: z.string().min(1).max(60),
  fieldValue: z.union([z.string(), z.number(), z.boolean()]),
  connector: z.string().min(1).max(40).default("rest-default"),
});
type Params = z.infer<typeof ParamSchema>;

interface UpdatedRecordData {
  connector: string;
  objectType: string;
  recordName: string;
  fieldName: string;
  fieldValue: string | number | boolean;
}

/* ---------------------------------------------------------------------
 * Intent matching
 * ------------------------------------------------------------------- */

/** Map user-friendly field aliases to vendor field names (Salesforce
 *  capitalization). Extend per-vendor when HubSpot lands. */
const FIELD_ALIASES: Record<string, string> = {
  stage: "StageName",
  amount: "Amount",
  "close date": "CloseDate",
  email: "Email",
  phone: "Phone",
  owner: "OwnerId",
  status: "Status",
  industry: "Industry",
  website: "Website",
  title: "Title",
  description: "Description",
};

function normalizeFieldName(raw: string): string {
  const lower = raw.toLowerCase().trim();
  return FIELD_ALIASES[lower] ?? raw.trim();
}

const OBJECT_ALIAS: Record<string, ObjectType> = {
  contact: "contact",
  contacts: "contact",
  person: "contact",
  deal: "deal",
  deals: "deal",
  opportunity: "opportunity",
  opportunities: "opportunity",
  account: "account",
  accounts: "account",
  company: "account",
  companies: "account",
};

const PATTERNS: Array<{ re: RegExp; build(m: RegExpExecArray): Partial<Params> | null }> = [
  {
    /* "move the Acme Renewal to Closed Won" / "move deal Q3 to Closed Won" */
    re: /\bmove\s+(?:the\s+)?(?:(deal|opportunity|contact|account)\s+)?(.+?)\s+to\s+(?:stage\s+)?(.+)$/i,
    build: (m) => {
      const obj = OBJECT_ALIAS[m[1]?.toLowerCase() ?? "deal"] ?? "deal";
      return {
        objectType: obj,
        recordName: m[2].trim(),
        fieldName: "StageName",
        fieldValue: m[3].trim().replace(/[.!?]+$/, ""),
      };
    },
  },
  {
    /* "update <object> <name>'s <field> to <value>" */
    re: /\bupdate\s+(?:the\s+)?(contact|deal|opportunity|account|company)\s+(.+?)(?:'s|s')\s+(\w[\w\s]{1,30}?)\s+to\s+(.+)$/i,
    build: (m) => ({
      objectType: OBJECT_ALIAS[m[1].toLowerCase()] ?? "contact",
      recordName: m[2].trim(),
      fieldName: normalizeFieldName(m[3]),
      fieldValue: m[4].trim().replace(/[.!?]+$/, ""),
    }),
  },
  {
    /* "set <name>'s phone to 555-0101" — without explicit object type;
       defaults to contact since phones are typically on contacts. */
    re: /\bset\s+(.+?)(?:'s|s')\s+(email|phone|title|description)\s+to\s+(.+)$/i,
    build: (m) => ({
      objectType: "contact",
      recordName: m[1].trim(),
      fieldName: normalizeFieldName(m[2]),
      fieldValue: m[3].trim().replace(/[.!?]+$/, ""),
    }),
  },
];

function matchUpdateIntent(message: string): Params | null {
  const trimmed = message.trim();
  for (const { re, build } of PATTERNS) {
    const m = re.exec(trimmed);
    if (!m) continue;
    const built = build(m);
    if (
      !built ||
      !built.objectType ||
      !built.recordName ||
      !built.fieldName ||
      built.fieldValue === undefined
    ) continue;
    if (built.recordName.length < 2) continue;
    return {
      objectType: built.objectType,
      recordName: built.recordName,
      fieldName: built.fieldName,
      fieldValue: coerceValue(built.fieldValue),
      connector: built.connector ?? "rest-default",
    };
  }
  return null;
}

/** Numeric strings become numbers (amounts: "50000" → 50000). Bool
 *  strings stay strings (Salesforce expects "true"/"false" in some
 *  contexts; safer to let the vendor coerce). */
function coerceValue(raw: string | number | boolean): string | number | boolean {
  if (typeof raw !== "string") return raw;
  const trimmed = raw.trim();
  /* Pure numeric (no commas, no dollar sign) → number. */
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const n = Number(trimmed);
    if (!Number.isNaN(n)) return n;
  }
  /* "$50,000" / "50k" / "$50k" → number. */
  const dollarMatch = /^\$?([\d,]+)(k|K)?$/.exec(trimmed);
  if (dollarMatch) {
    const n = Number(dollarMatch[1].replace(/,/g, ""));
    if (!Number.isNaN(n)) return dollarMatch[2] ? n * 1000 : n;
  }
  return trimmed;
}

/* ---------------------------------------------------------------------
 * Description (for the confirmation prompt)
 * ------------------------------------------------------------------- */

export function describeUpdateAction(p: Params): string {
  return `update ${p.objectType} "${p.recordName}" → ${p.fieldName} = ${p.fieldValue}`;
}

/* ---------------------------------------------------------------------
 * Execution — called from assistant.ts.executePendingAction.
 *
 * Steps:
 *   1. Pick the workspace's configured connector (salesforce, hubspot, …).
 *   2. Resolve recordName → id via searchRecords.
 *   3. If 0 results → refuse (write must hit a real record).
 *   4. If 2+ results → refuse (ambiguous; user must specify by id).
 *   5. PATCH with { [fieldName]: fieldValue }.
 * ------------------------------------------------------------------- */

export async function executeUpdateExternalRecord(
  params: Params,
  ctx: { userId: string; userRole: string; workspaceId?: string; agentId?: string },
): Promise<
  | { ok: true; id: string; connector: string }
  | { ok: false; reason: string; matchCount?: number }
> {
  const workspaceId = ctx.workspaceId || "default";
  /* Least-privilege at approval-execution: scope the connector to the agent's
     bound set when ctx.agentId is set (the approval route passes it). The human
     path (no agentId) resolves byte-for-byte as before. */
  const agentId = ctx.agentId;
  let resolvedConnectorName = params.connector;
  if (params.connector === "rest-default") {
    const preferred = agentId
      ? await pickConfiguredConnector(workspaceId, agentId)
      : await pickConfiguredConnector(workspaceId);
    if (preferred && preferred !== "rest-default") resolvedConnectorName = preferred;
  }
  let connector: Awaited<ReturnType<typeof buildRestConnectorForWorkspace>>;
  try {
    connector = agentId
      ? await buildRestConnectorForWorkspace(workspaceId, resolvedConnectorName, agentId)
      : await buildRestConnectorForWorkspace(workspaceId, resolvedConnectorName);
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
  if (!connector.isConfigured()) {
    return { ok: false, reason: `connector "${resolvedConnectorName}" is not configured` };
  }
  if (typeof connector.updateRecord !== "function") {
    return { ok: false, reason: `connector "${resolvedConnectorName}" does not support writes` };
  }

  /* Resolve recordName → id. Search for up to 5; refuse anything but
     exactly 1 — writes on ambiguous matches are dangerous. */
  const lookupType = params.objectType === "opportunity" ? "deal" : params.objectType;
  const searchResult = await connector.searchRecords(lookupType, params.recordName, 5);
  if (!searchResult.ok) {
    return { ok: false, reason: `lookup_failed: ${searchResult.message ?? searchResult.code ?? "unknown"}` };
  }
  const matches = searchResult.data ?? [];
  if (matches.length === 0) {
    return { ok: false, reason: "no_match_found", matchCount: 0 };
  }
  if (matches.length > 1) {
    return { ok: false, reason: "ambiguous", matchCount: matches.length };
  }

  const idValue = (matches[0] as { Id?: string; id?: string }).Id ?? (matches[0] as { id?: string }).id;
  if (!idValue) {
    return { ok: false, reason: "matched record has no id" };
  }

  const result = await connector.updateRecord(lookupType, idValue, {
    [params.fieldName]: params.fieldValue,
  });
  trackEvent("assistant.connector_write_executed", ctx.userId, ctx.userRole, {
    op: "update",
    connector: resolvedConnectorName,
    object_type: params.objectType,
    field_name: params.fieldName,
    ok: result.ok,
    duration_ms: result.durationMs ?? 0,
    code: result.ok ? "ok" : result.code ?? "unknown",
  });
  if (!result.ok) {
    return { ok: false, reason: result.message ?? result.code ?? "update_failed" };
  }
  return { ok: true, id: idValue, connector: resolvedConnectorName };
}

/* ---------------------------------------------------------------------
 * Tool definition
 * ------------------------------------------------------------------- */

export const updateExternalRecordTool: ToolDef<Params, UpdatedRecordData> = {
  name: "update_external_record",
  description:
    "Update a single field on an existing CRM record (move opportunity stages, change phone/email, etc). Requires user confirmation.",
  paramSchema: ParamSchema,
  capability: "*",
  requiresConfirmation: true,
  matchIntent: matchUpdateIntent,
  async handler(params, _ctx): Promise<ToolResult<UpdatedRecordData>> {
    return {
      ok: true,
      data: {
        connector: params.connector,
        objectType: params.objectType,
        recordName: params.recordName,
        fieldName: params.fieldName,
        fieldValue: params.fieldValue,
      },
      answer: `Will ${describeUpdateAction(params)}`,
    };
  },
};

registerTool(updateExternalRecordTool);
