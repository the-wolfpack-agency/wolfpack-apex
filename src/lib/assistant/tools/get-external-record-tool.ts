/**
 * get_external_record tool — first connector-backed tool.
 *
 * Answers questions like:
 *   "Look up contact id ABC-123"
 *   "Get the deal record for 7HJ-99"
 *   "Find the company with id acme-corp in our CRM"
 *
 * Uses the default REST connector (env-configured for the first
 * Phase-4 slice; per-tenant credentials follow). Returns a formatted
 * Markdown summary of the retrieved record + a source link.
 *
 * Read-only — no confirmation required. Action variants
 * (create_external_record, update_external_record) drop in later
 * behind the existing requiresConfirmation gate.
 */

import { z } from "zod";
import { getConnector } from "@/lib/assistant/connectors";
import { registerTool } from "./registry";
import type { ToolDef, ToolResult } from "./types";

const ParamSchema = z.object({
  objectType: z.enum([
    "contact",
    "deal",
    "company",
    "account",
    "invoice",
    "payment",
    "ticket",
  ]),
  id: z.string().min(1).max(120),
  connector: z.string().min(1).max(40).default("rest-default"),
});
type Params = z.infer<typeof ParamSchema>;

interface ExternalRecordData {
  connector: string;
  objectType: string;
  id: string;
  record: Record<string, unknown>;
}

const PATTERNS: Array<{ re: RegExp; build(m: RegExpExecArray): Partial<Params> | null }> = [
  {
    /* "look up <objectType> id <id>" / "get <objectType> record for <id>" */
    re: /\b(?:look\s+up|get|fetch|find|pull)\s+(?:the\s+)?(contact|deal|company|account|invoice|payment|ticket)(?:\s+(?:id|record(?:\s+for)?|with\s+id))?\s+([A-Za-z0-9._-]{1,120})\b/i,
    build: (m) => ({
      objectType: m[1].toLowerCase() as Params["objectType"],
      id: m[2],
    }),
  },
  {
    /* "show me <objectType> <id>" — simpler verb */
    re: /\bshow\s+(?:me\s+)?(?:the\s+)?(contact|deal|company|account|invoice|payment|ticket)\s+([A-Za-z0-9._-]{1,120})\b/i,
    build: (m) => ({
      objectType: m[1].toLowerCase() as Params["objectType"],
      id: m[2],
    }),
  },
];

function matchExternalRecordIntent(message: string): Params | null {
  const trimmed = message.trim();
  for (const { re, build } of PATTERNS) {
    const m = re.exec(trimmed);
    if (!m) continue;
    const built = build(m);
    if (!built || !built.objectType || !built.id) continue;
    return {
      objectType: built.objectType,
      id: built.id,
      connector: "rest-default",
    };
  }
  return null;
}

export const getExternalRecordTool: ToolDef<Params, ExternalRecordData> = {
  name: "get_external_record",
  description:
    "Look up a record (contact, deal, company, invoice, payment, ticket) in an external system via a configured connector.",
  paramSchema: ParamSchema,
  capability: "*",
  matchIntent: matchExternalRecordIntent,
  async handler(params, _ctx): Promise<ToolResult<ExternalRecordData>> {
    const connector = getConnector(params.connector);
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
          connector: params.connector,
          objectType: params.objectType,
          id: params.id,
          record: {},
        },
        answer: `The "${params.connector}" connector isn't configured yet. Set INSTINCT_REST_CRM_BASE_URL + INSTINCT_REST_CRM_AUTH (or wire per-tenant credentials) and try again.`,
      };
    }
    const result = await connector.getRecord(params.objectType, params.id);
    if (!result.ok) {
      if (result.code === "not_found") {
        return {
          ok: true,
          data: {
            connector: params.connector,
            objectType: params.objectType,
            id: params.id,
            record: {},
          },
          answer: `No ${params.objectType} found with id \`${params.id}\` in the configured CRM.`,
        };
      }
      return {
        ok: false,
        code: result.code === "auth_failed" ? "capability" : "internal",
        message:
          (result.message ?? "external lookup failed") +
          ` (connector=${params.connector}, took ${result.durationMs ?? 0}ms)`,
      };
    }
    const record = (result.data ?? {}) as Record<string, unknown>;
    return {
      ok: true,
      data: {
        connector: params.connector,
        objectType: params.objectType,
        id: params.id,
        record,
      },
      answer: formatRecordAnswer(params.objectType, params.id, record),
    };
  },
};

function formatRecordAnswer(
  objectType: string,
  id: string,
  record: Record<string, unknown>,
): string {
  const keys = Object.keys(record).slice(0, 12);
  if (keys.length === 0) {
    return `Found ${objectType} \`${id}\` but the remote returned an empty record.`;
  }
  const lines = [`**${objectType[0].toUpperCase() + objectType.slice(1)}** \`${id}\` (from external CRM):`];
  for (const k of keys) {
    const v = record[k];
    const summary =
      typeof v === "string"
        ? v.slice(0, 200)
        : typeof v === "number" || typeof v === "boolean"
        ? String(v)
        : v === null || v === undefined
        ? "(empty)"
        : "(complex value)";
    lines.push(`- **${k}**: ${summary}`);
  }
  if (Object.keys(record).length > 12) {
    lines.push(`- _…and ${Object.keys(record).length - 12} more fields_`);
  }
  return lines.join("\n");
}

registerTool(getExternalRecordTool);
