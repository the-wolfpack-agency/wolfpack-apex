/**
 * create_external_record tool — Phase-3 action tool for adding rows to
 * the configured CRM. Wraps the connector's createRecord with intent
 * matching + the existing confirmation flow.
 *
 * Supported object types:
 *   contact  → name, email, phone (+ vendor-specific extras the LLM
 *              might propose later)
 *   deal     → name, amount, stage, close_date (Salesforce Opportunity)
 *   account  → name, industry, phone, website (Salesforce Account)
 *   task     → subject, owner, due_date, status (activity logging)
 *
 * Intent matching is deliberately strict — we'd rather miss and let the
 * LLM ask for clarification than fire a write on a fuzzy phrase. Every
 * action goes through the existing pending_actions confirmation gate,
 * so a successful match shows a "Will create X / Confirm?" preview;
 * the user has to say "yes" / "confirm" / "go ahead" before the connector
 * fires.
 *
 * Execution: assistant.ts.executePendingAction switches on toolName ===
 * "create_external_record" and calls executeCreateExternalRecord() in
 * this module (exported below) with the persisted params.
 */

import { z } from "zod";
import {
  buildRestConnectorForWorkspace,
  pickConfiguredConnector,
} from "@/lib/assistant/connectors";
import { trackEvent } from "@/lib/analytics";
import { registerTool } from "./registry";
import type { ToolDef, ToolResult } from "./types";

const OBJECT_TYPES = ["contact", "deal", "account", "task"] as const;
type ObjectType = (typeof OBJECT_TYPES)[number];

/* The fields object is intentionally loose — vendors have lots of
   optional fields and we want to let advanced operators pass anything
   the LLM proposes. Strict per-vendor schemas land when a regression
   warrants. */
const ParamSchema = z.object({
  objectType: z.enum(OBJECT_TYPES),
  fields: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
  connector: z.string().min(1).max(40).default("rest-default"),
});
type Params = z.infer<typeof ParamSchema>;

interface CreatedRecordData {
  connector: string;
  objectType: ObjectType;
  id: string;
  fields: Record<string, unknown>;
}

/* ---------------------------------------------------------------------
 * Intent matching
 * ------------------------------------------------------------------- */

const EMAIL_RE = /([\w.+-]+@[\w-]+(?:\.[\w-]+)+)/;
const PHONE_RE = /\b(\+?\d[\d\s().-]{6,}\d)\b/;
/** Match "$50,000", "$50k", "50000", "50k". Group 1 = the numeric
 *  portion, group 2 = an optional 'k'/'m' multiplier. The 'k' suffix
 *  must directly follow the digits (or one whitespace) to count. */
const AMOUNT_RE = /\$?(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d{2,9})\s*([kKmM])?\b/;
const STAGE_RE = /\bstage\s+([A-Za-z][A-Za-z\s'-]{1,40}?)(?=\s+(?:amount|close|email|phone|owner)|[,.;:]|$)/i;
const CLOSE_RE = /\bclose(?:\s+date)?\s+(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4})/i;

/** Parse "create a contact named Jane Doe at Acme, email jane@acme.com
 *  phone 555-0101" → {objectType: contact, fields: {Name, Email, Phone, ...}}.
 *
 *  Per-object field extractors keep the LLM-fallback footprint small —
 *  we set what we can parse deterministically; anything ambiguous goes
 *  to the LLM if/when we wire that path. */
function extractContactFields(msg: string): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  const email = EMAIL_RE.exec(msg);
  if (email) fields.Email = email[1];
  const phone = PHONE_RE.exec(msg);
  if (phone) fields.Phone = phone[1].replace(/\s+/g, " ").trim();
  /* Two regexes for name capture:
     - prefix matched case-insensitively (works with "contact:", "Contact:",
       "Named:", etc).
     - name itself matched STRICT case so trailing lowercase words like
       "email jane@acme.com" don't get swallowed into LastName. The /i
       on the whole regex would have made [A-Z] match any case. */
  /* Match "contact" + an explicit separator (colon, comma, or
     "named"/"called") OR just whitespace. Greedy `\s*` ate the
     between-word space previously, leaving "named Jane..." instead
     of "Jane..." in the tail. */
  const prefixMatch = /\bcontact\b(?:\s*[:,]\s*|\s+(?:named|called|name)\s+|\s+)/i.exec(msg);
  if (prefixMatch) {
    const tail = msg.slice(prefixMatch.index + prefixMatch[0].length);
    /* Strict-case name: capital-first, additional capital-first words
       chained by whitespace. Stops at any lowercase word. */
    const nameMatch = /^([A-Z][\w'.-]+(?:\s+[A-Z][\w'.-]+)*)/.exec(tail);
    if (nameMatch) {
      const fullName = nameMatch[1].trim();
      const parts = fullName.split(/\s+/);
      if (parts.length >= 2) {
        fields.FirstName = parts[0];
        fields.LastName = parts.slice(1).join(" ");
      } else {
        fields.LastName = fullName;
      }
    }
  }
  /* Account hint — independent capture, strict case for the same
     reason. "at Acme" or "at Acme Industries". */
  const accountMatch = /\bat\s+([A-Z][\w'.-]+(?:\s+[A-Z][\w'.-]+)*)/.exec(msg);
  if (accountMatch && fields.LastName) {
    fields.AccountName_hint = accountMatch[1].trim();
  }
  return fields;
}

function extractDealFields(msg: string): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  /* Capture the deal Name as everything between "deal"/"opportunity"
     and the next field hint (amount, stage, close, worth, $, comma).
     "create a $50k deal for Acme stage..." → Name = "Acme". */
  const nameMatch = /\b(?:deal|opportunity)\s+(?:called|named|for)?\s*([A-Z][\w\s'.-]*?)(?=\s+(?:amount|stage|close|worth|\$)|[,.;]|$)/i.exec(msg);
  if (nameMatch && nameMatch[1].trim()) fields.Name = nameMatch[1].trim();
  const amount = AMOUNT_RE.exec(msg);
  if (amount) {
    const raw = amount[1].replace(/,/g, "");
    let n = Number(raw);
    const suffix = amount[2]?.toLowerCase();
    if (suffix === "k") n *= 1000;
    else if (suffix === "m") n *= 1_000_000;
    if (!Number.isNaN(n)) fields.Amount = n;
  }
  const stage = STAGE_RE.exec(msg);
  if (stage) fields.StageName = stage[1].trim();
  const close = CLOSE_RE.exec(msg);
  if (close) {
    /* Normalize MM/DD/YYYY → YYYY-MM-DD; pass ISO through unchanged. */
    const raw = close[1];
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      fields.CloseDate = raw;
    } else {
      const [m, d, y] = raw.split("/").map((s) => s.padStart(2, "0"));
      const year = y.length === 2 ? `20${y}` : y;
      fields.CloseDate = `${year}-${m}-${d}`;
    }
  }
  return fields;
}

function extractAccountFields(msg: string): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  /* Two phrasings cover most cases:
     A) "create the Acme Industries account ..." → name before the word "account"
     B) "create an account called Acme ..."      → name after "account named/called"
     We try B first, then fall back to A. */
  let nameMatch = /\b(?:account|company)\s+(?:called|named|for)\s+([A-Z][\w\s&'.-]*?)(?=\s+(?:industry|phone|website|in)|[,.;]|$)/i.exec(msg);
  if (!nameMatch) {
    nameMatch = /\b(?:create|add|new)\s+(?:a\s+|the\s+|an\s+)?([A-Z][\w\s&'.-]*?)\s+(?:account|company)\b/i.exec(msg);
  }
  if (nameMatch && nameMatch[1].trim()) fields.Name = nameMatch[1].trim();
  const phone = PHONE_RE.exec(msg);
  if (phone) fields.Phone = phone[1].replace(/\s+/g, " ").trim();
  const industry = /\bindustry\s+([A-Z][\w\s'&-]*?)(?=[,.;]|\s+(?:phone|website)|$)/i.exec(msg);
  if (industry) fields.Industry = industry[1].trim();
  return fields;
}

function extractTaskFields(msg: string): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  /* "log a call with Jorge about pricing" → Subject="call with Jorge about pricing"
     Find the activity verb in the FULL message; subject runs from
     there to end. */
  const verbMatch = /\b(call|meeting|email|note|task|activity)\b/i.exec(msg);
  if (verbMatch) {
    const subject = msg.slice(verbMatch.index).replace(/^(?:a\s+|the\s+)?/i, "").trim();
    fields.Subject = subject.slice(0, 255);
  }
  /* Salesforce Task requires Status; "log" = past, "create" = future. */
  fields.Status = /\blog(?:ged)?\b/i.test(msg) ? "Completed" : "Open";
  return fields;
}

const TYPE_DETECTORS: Array<{ re: RegExp; type: ObjectType; extract: (msg: string) => Record<string, unknown> }> = [
  /* Task / Activity comes FIRST so "log a call" doesn't get swept up
     by a more general contact/account pattern that mentions "call". */
  { re: /\b(?:log|record)\b.*\b(?:call|meeting|email|note|task|activity)\b/i, type: "task", extract: extractTaskFields },
  { re: /\b(?:create|add|new)\b.*\b(?:task|activity)\b/i, type: "task", extract: extractTaskFields },
  /* Contact + Deal + Account each detect by verb-then-object. */
  { re: /\b(?:create|add|new)\b.*\bcontact\b/i, type: "contact", extract: extractContactFields },
  { re: /\b(?:create|add|new)\b.*\b(?:deal|opportunity)\b/i, type: "deal", extract: extractDealFields },
  { re: /\b(?:create|add|new)\b.*\b(?:account|company)\b/i, type: "account", extract: extractAccountFields },
];

function matchCreateIntent(message: string): Params | null {
  const trimmed = message.trim();
  for (const { re, type, extract } of TYPE_DETECTORS) {
    if (!re.test(trimmed)) continue;
    const fields = extract(trimmed);
    /* Require AT LEAST one non-trivial field so we don't fire a write
       on "create a contact" with no name. */
    if (Object.keys(fields).length === 0) continue;
    return {
      objectType: type,
      fields: fields as Record<string, string | number | boolean | null>,
      connector: "rest-default",
    };
  }
  return null;
}

/* ---------------------------------------------------------------------
 * Description (for the confirmation prompt)
 * ------------------------------------------------------------------- */

export function describeCreateAction(p: Params): string {
  const labelByType: Record<ObjectType, string> = {
    contact: "Contact",
    deal: "Opportunity",
    account: "Account",
    task: "Task",
  };
  const hint = renderFieldsCompact(p.fields);
  return `create a ${labelByType[p.objectType]}: ${hint}`;
}

function renderFieldsCompact(fields: Record<string, unknown>): string {
  const order = ["Name", "FirstName", "LastName", "Subject", "Email", "Phone", "Amount", "StageName", "CloseDate", "Industry", "Status", "AccountName_hint"];
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const k of order) {
    if (k in fields) {
      parts.push(`${k}=${String(fields[k])}`);
      seen.add(k);
    }
  }
  for (const [k, v] of Object.entries(fields)) {
    if (seen.has(k)) continue;
    parts.push(`${k}=${String(v)}`);
  }
  return parts.join(", ");
}

/* ---------------------------------------------------------------------
 * Execution — called from assistant.ts.executePendingAction after the
 * user confirms.
 * ------------------------------------------------------------------- */

export async function executeCreateExternalRecord(
  params: Params,
  ctx: { userId: string; userRole: string; workspaceId?: string; agentId?: string },
): Promise<{ ok: true; id: string; connector: string } | { ok: false; reason: string }> {
  const workspaceId = ctx.workspaceId || "default";
  /* Least-privilege at approval-execution: when the captured write came from an
     agent (ctx.agentId set by the approval route), the connector pick + build are
     scoped to that agent's bound set. An unbound connector throws
     ConnectorScopeError (surfaced as a typed reason). The human-confirm path
     (no agentId) resolves byte-for-byte as before. */
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
  if (typeof connector.createRecord !== "function") {
    return { ok: false, reason: `connector "${resolvedConnectorName}" does not support writes` };
  }
  /* Drop internal hint fields the vendor doesn't know about. */
  const cleanFields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params.fields)) {
    if (k.endsWith("_hint")) continue;
    cleanFields[k] = v;
  }
  const result = await connector.createRecord(params.objectType, cleanFields);
  trackEvent("assistant.connector_write_executed", ctx.userId, ctx.userRole, {
    op: "create",
    connector: resolvedConnectorName,
    object_type: params.objectType,
    ok: result.ok,
    duration_ms: result.durationMs ?? 0,
    code: result.ok ? "ok" : result.code ?? "unknown",
  });
  if (!result.ok) {
    return { ok: false, reason: result.message ?? result.code ?? "write_failed" };
  }
  return { ok: true, id: result.data?.id ?? "", connector: resolvedConnectorName };
}

/* ---------------------------------------------------------------------
 * Tool definition
 * ------------------------------------------------------------------- */

export const createExternalRecordTool: ToolDef<Params, CreatedRecordData> = {
  name: "create_external_record",
  description:
    "Create a record (contact, deal, account, task) in the configured CRM. Requires user confirmation.",
  paramSchema: ParamSchema,
  capability: "*",
  requiresConfirmation: true,
  matchIntent: matchCreateIntent,
  async handler(params, _ctx): Promise<ToolResult<CreatedRecordData>> {
    /* Same shape as save_team_fact: the dispatcher's confirmation gate
       returns needs_confirmation BEFORE this body executes. After
       confirm, chat() calls executeCreateExternalRecord(...) directly. */
    return {
      ok: true,
      data: {
        connector: params.connector,
        objectType: params.objectType,
        id: "(pending confirmation)",
        fields: params.fields,
      },
      answer: `Will ${describeCreateAction(params)}`,
    };
  },
};

registerTool(createExternalRecordTool);
