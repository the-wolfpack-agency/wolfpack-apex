/**
 * who_is — answer "who is <name>" with team-first then CRM-fallback.
 *
 * The bug this fixes: the landing-page chip "who is <teammate>" used
 * to route directly to search_external_records, which only queries
 * the configured CRM. Asking "who is Nick Homyk" (a literal team
 * member) returned "No contact matches found in the configured CRM"
 * — wrong, confusing, and worst on the empty-state surface where a
 * brand new user lands.
 *
 * This tool owns the full "who is X" flow end to end:
 *   1. Look up internal team_members (case-insensitive name/email).
 *   2. On miss, fall back to CRM contact search via the same
 *      workspace connector search_external_records uses.
 *   3. If both miss, return a clean answer that names what we
 *      checked + suggests next steps — NEVER the "no contact in CRM"
 *      message that started this bug.
 *
 * Registered BEFORE search_external_records in the cascade so the
 * "who is" regex no longer surfaces a CRM-only answer.
 */

import { z } from "zod";
import { safeQuery } from "@/lib/db";
import { trackEvent } from "@/lib/analytics";
import { registerTool } from "./registry";
import { resolveScopedConnector } from "./resolve-connector";
import type { ToolContext, ToolDef, ToolResult } from "./types";

const ParamSchema = z.object({
  query: z.string().min(1).max(120),
});
type Params = z.infer<typeof ParamSchema>;

export interface WhoIsResult {
  source: "team" | "crm" | "none";
  matchCount: number;
  teamMembers: Array<{
    id: string;
    name: string;
    email: string;
    role: string;
  }>;
  crmRecords: Array<Record<string, unknown>>;
}

const WHO_IS_RE = /\bwho\s+is\s+(.{2,120})\??$/i;

/**
 * "what does Jorge do" is the same question as "who is Jorge".
 *
 * A routing audit on 2026-08-26 found it reached no tool. People ask about a
 * colleague both ways and the second way is at least as common, because it is
 * what you say when you know the name and not the job.
 *
 * Kept separate from WHO_IS_RE rather than folded into one pattern, because
 * this one has to be narrow: the subject must look like a NAME. "what does
 * this button do" and "what does the contract say" are not questions about a
 * person, and a person lookup answering them is the confident wrong answer
 * this codebase keeps finding.
 */
const WHAT_DOES_X_DO_RE =
  /^\s*what\s+does\s+([A-Z][\w'-]*(?:\s+[A-Z][\w'-]*)?)\s+(?:do|work\s+on|focus\s+on)\s*\??\s*$/;

function matchWhoIsIntent(message: string): Params | null {
  const trimmed = message.trim();
  const m = WHO_IS_RE.exec(trimmed) ?? WHAT_DOES_X_DO_RE.exec(trimmed);
  if (!m) return null;
  const q = m[1].trim().replace(/[?.!]+$/, "").trim();
  if (!q) return null;
  return { query: q };
}

export async function lookupTeamMembers(
  query: string,
): Promise<WhoIsResult["teamMembers"]> {
  if (!process.env.DATABASE_URL) return [];
  const q = query.trim();
  if (q.length < 2) return [];
  try {
    const isEmailish = q.includes("@");
    const r = await safeQuery<{
      id: string;
      name: string;
      email: string;
      role: string;
    }>(
      isEmailish
        ? `SELECT id, name, email, role
             FROM instinct_team_members
            WHERE is_active = true
              AND (LOWER(email) = LOWER($1) OR LOWER(name) ILIKE LOWER($2))
            ORDER BY (LOWER(name) = LOWER($1)) DESC, name ASC
            LIMIT 5`
        : `SELECT id, name, email, role
             FROM instinct_team_members
            WHERE is_active = true
              AND LOWER(name) ILIKE LOWER($2)
            ORDER BY (LOWER(name) = LOWER($1)) DESC, name ASC
            LIMIT 5`,
      [q, `%${q}%`],
    );
    return r.rows;
  } catch {
    return [];
  }
}

function renderTeamHit(members: WhoIsResult["teamMembers"]): string {
  if (members.length === 1) {
    const m = members[0];
    return `${m.name} is on the team. Role: ${m.role}. Email: ${m.email}.`;
  }
  const lines = members.map(
    (m) => `- ${m.name} (${m.role}) — ${m.email}`,
  );
  return `Found ${members.length} team members matching that name:\n${lines.join(
    "\n",
  )}`;
}

function renderCrmHit(
  query: string,
  records: Array<Record<string, unknown>>,
): string {
  const name = (r: Record<string, unknown>) => {
    const candidate = r["Name"] ?? r["name"] ?? r["fullName"] ?? r["FullName"];
    return typeof candidate === "string" && candidate.trim()
      ? candidate
      : "(unnamed)";
  };
  if (records.length === 1) {
    const r = records[0];
    const email = r["Email"] ?? r["email"] ?? "";
    const emailStr =
      typeof email === "string" && email.trim() ? ` — ${email}` : "";
    return `Found 1 CRM contact matching "${query}": ${name(r)}${emailStr}.`;
  }
  const top = records.slice(0, 5);
  const list = top.map((r, i) => `${i + 1}. ${name(r)}`).join("\n");
  return `Found ${records.length} CRM contacts matching "${query}":\n${list}`;
}

function renderMiss(query: string, crmAvailable: boolean): string {
  if (crmAvailable) {
    return `No one named "${query}" on the team roster or in the CRM. If they're external, try \`find contacts named ${query}\`. If they're internal, check that they've been added at /people.`;
  }
  return `No one named "${query}" on the team roster. To search beyond the internal team, connect Salesforce or HubSpot at /settings. Then ask again.`;
}

async function searchCrmContacts(
  ctx: ToolContext,
  query: string,
): Promise<{
  ok: boolean;
  configured: boolean;
  records: Array<Record<string, unknown>>;
}> {
  try {
    /* Scope-enforcing resolve: for a real agent the resolver returns a failure
       when the agent is not bound to a CRM connector. who_is is team-first, so
       we degrade that to "CRM not available" (the team-only miss message) rather
       than surfacing a hard error. The human path resolves exactly as before. */
    const resolved = await resolveScopedConnector(ctx, "rest-default");
    if (!resolved.ok) {
      return { ok: true, configured: false, records: [] };
    }
    const connector = resolved.connector;
    if (!connector || !connector.isConfigured()) {
      return { ok: true, configured: false, records: [] };
    }
    const result = await connector.searchRecords("contact", query, 5);
    if (!result.ok) {
      return { ok: false, configured: true, records: [] };
    }
    return { ok: true, configured: true, records: result.data ?? [] };
  } catch {
    return { ok: false, configured: true, records: [] };
  }
}

export const whoIsTool: ToolDef<Params, WhoIsResult> = {
  name: "who_is",
  description:
    "Identify a person by name. Checks the internal team roster first, then falls back to CRM contact search. Replaces the old behavior of asking the CRM only — which returned 'no contact match' for every literal teammate.",
  paramSchema: ParamSchema,
  capability: "*",
  matchIntent: matchWhoIsIntent,
  async handler(params, ctx): Promise<ToolResult<WhoIsResult>> {
    const members = await lookupTeamMembers(params.query);

    if (members.length > 0) {
      trackEvent("assistant.tool_invoked", ctx.userId, ctx.userRole, {
        tool: "who_is",
        outcome: "team_hit",
        query: params.query,
        match_count: members.length,
        ...(ctx.workflowId ? { workflow_id: ctx.workflowId } : {}),
      });
      return {
        ok: true,
        data: {
          source: "team",
          matchCount: members.length,
          teamMembers: members,
          crmRecords: [],
        },
        answer: renderTeamHit(members),
      };
    }

    const crm = await searchCrmContacts(ctx, params.query);

    if (crm.records.length > 0) {
      trackEvent("assistant.tool_invoked", ctx.userId, ctx.userRole, {
        tool: "who_is",
        outcome: "crm_hit",
        query: params.query,
        match_count: crm.records.length,
        ...(ctx.workflowId ? { workflow_id: ctx.workflowId } : {}),
      });
      return {
        ok: true,
        data: {
          source: "crm",
          matchCount: crm.records.length,
          teamMembers: [],
          crmRecords: crm.records,
        },
        answer: renderCrmHit(params.query, crm.records),
      };
    }

    trackEvent("assistant.tool_invoked", ctx.userId, ctx.userRole, {
      tool: "who_is",
      outcome: "miss",
      query: params.query,
      crm_configured: crm.configured,
      ...(ctx.workflowId ? { workflow_id: ctx.workflowId } : {}),
    });
    return {
      ok: true,
      data: {
        source: "none",
        matchCount: 0,
        teamMembers: [],
        crmRecords: [],
      },
      answer: renderMiss(params.query, crm.configured),
    };
  },
};

registerTool(whoIsTool);
