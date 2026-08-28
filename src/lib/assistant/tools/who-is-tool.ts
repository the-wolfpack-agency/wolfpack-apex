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
  /* A roster question is claimed here so it cannot fall through to documents
     or a model, but it is NOT a name lookup. The marker is read back in the
     handler; nothing else in the product uses this shape. */
  const roster = matchRosterQuestion(trimmed);
  if (roster) return { query: ROSTER_MARKER + (roster.area ?? "") };
  const m = WHO_IS_RE.exec(trimmed) ?? WHAT_DOES_X_DO_RE.exec(trimmed);
  if (!m) return null;
  const q = m[1].trim().replace(/[?.!]+$/, "").trim();
  if (!q) return null;
  return { query: q };
}


/**
 * A question about the WHOLE team, not about one person.
 *
 * THE BUG THIS FIXES. WHO_IS_RE is `who is (.{2,120})`, so "who is on the
 * team" captured "on the team" as somebody's name and the assistant answered
 * "No one named 'on the team' on the team roster". Absurd on a completely
 * reasonable question, and the first thing a new user is likely to type.
 *
 * The variants that fell through were worse than absurd. "who works here"
 * reached the answer cache and came back with four SharePoint documents cited
 * that had nothing to do with the question. "who do we have in sales" reached
 * a model, which read a client's survey spreadsheet and presented three of
 * that client's staff as our sales team, complete with citations. A roster
 * question that escapes the roster ends up answered from whatever documents
 * happen to mention people.
 *
 * So these are recognised as their own shape and answered from the team table.
 */
const ROSTER_RE =
  /^\s*(?:who(?:'s|\s+is|\s+are)?\s+(?:on\s+(?:the|our|my)\s+team|here|we|us)|who\s+works\s+here|who\s+(?:do\s+we|does\s+the\s+team)\s+have(?:\s+in\s+(?<area>.{2,40}?))?|show\s+me\s+(?:the|our)\s+team|list\s+(?:the|our)\s+team)\s*[?.!]*\s*$/i;

export interface RosterQuestion {
  /** A role or area to filter by, when the question named one. */
  area?: string;
}

/** Whether this is a roster question, and what it asked to narrow by. */
export function matchRosterQuestion(message: string): RosterQuestion | null {
  const m = ROSTER_RE.exec(message.trim());
  if (!m) return null;
  const area = m.groups?.area?.trim();
  return area ? { area } : {};
}

/**
 * Accounts that are machinery rather than colleagues.
 *
 * Measured against the real roster: 11 of 19 active members are automation.
 * Seven copies of "E2E (automated tests)", a CI smoke account, a health bot,
 * and one called "TEST". Answering "who is on the team" with those in the list
 * is embarrassing in front of a client and useless to everyone else, because
 * nobody asking that question means "and your continuous integration
 * credentials".
 *
 * Names rather than a flag, because there is no column that marks a service
 * account and inventing one would mean a migration plus somebody remembering
 * to set it.
 *
 * EVERY TOKEN IS WORD-ANCHORED, and a test caught why. Written first as
 * /^test/, which hides a real person called Testa. /^test\b/ does not, and the
 * same reasoning keeps "Roberta Bott" out of the bot pattern. Hiding a
 * colleague from the roster would be a worse bug than showing a robot.
 *
 * This hides them from the ANSWER. It does not delete them, and the roster at
 * /people still shows everything, because the data is not wrong, it is just
 * not what was asked for.
 */
const AUTOMATION_NAME =
  /^(?:test\b|e2e\b|ci\s|.*\bautomated tests?\b|.*\bhealth bot\b|.*\bsmoke\b|.*\bbot\b)/i;

export function isAutomationForTests(m: { name: string; email: string }): boolean {
  return isAutomation(m);
}

function isAutomation(m: { name: string; email: string }): boolean {
  return AUTOMATION_NAME.test(m.name.trim());
}

/**
 * The team, optionally narrowed to a role.
 *
 * Reads instinct_team_members, which is OUR roster. That matters more than it
 * sounds: the failure this replaces answered "who do we have in sales" from a
 * client's survey data, so the table being ours is the whole point.
 */
export async function listTeam(
  area?: string,
): Promise<WhoIsResult["teamMembers"]> {
  if (!process.env.DATABASE_URL) return [];
  try {
    const r = await safeQuery<{ id: string; name: string; email: string; role: string }>(
      area
        ? `SELECT id, name, email, role
             FROM instinct_team_members
            WHERE is_active = true AND LOWER(role) ILIKE LOWER($1)
            ORDER BY name ASC
            LIMIT 50`
        : `SELECT id, name, email, role
             FROM instinct_team_members
            WHERE is_active = true
            ORDER BY name ASC
            LIMIT 50`,
      area ? [`%${area}%`] : [],
    );
    return r.rows.filter((m) => !isAutomation(m));
  } catch {
    return [];
  }
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

/** A marker, not a name. Kept private so no caller can pass one by accident. */
const ROSTER_MARKER = "\u0000roster:";

function renderRoster(
  team: WhoIsResult["teamMembers"],
  area?: string,
): string {
  const lines = team.map((m) => `- ${m.name} (${m.role})`);
  const heading = area
    ? `${team.length} on the team in ${area}:`
    : `${team.length} on the team:`;
  return `${heading}\n${lines.join("\n")}`;
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
    /* THE WHOLE TEAM, when that is what was asked. Answered from our own
       roster table rather than from whatever documents mention people, which
       is how "who do we have in sales" previously returned a client's staff
       out of a survey spreadsheet. */
    if (params.query.startsWith(ROSTER_MARKER)) {
      const area = params.query.slice(ROSTER_MARKER.length).trim();
      const team = await listTeam(area || undefined);
      trackEvent("assistant.tool_invoked", ctx.userId, ctx.userRole, {
        tool: "who_is",
        outcome: team.length > 0 ? "roster" : "roster_empty",
        match_count: team.length,
        ...(ctx.workflowId ? { workflow_id: ctx.workflowId } : {}),
      });
      return {
        ok: true,
        data: { source: "team", matchCount: team.length, teamMembers: team, crmRecords: [] },
        answer:
          team.length > 0
            ? renderRoster(team, area || undefined)
            : area
              ? `No one on the team has a role matching "${area}". You can see everyone at /people.`
              : "The team roster is empty. People are added at /people.",
      };
    }

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
