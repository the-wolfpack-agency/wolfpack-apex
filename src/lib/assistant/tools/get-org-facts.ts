/**
 * get_org_facts tool — Phase 1's first registered tool.
 *
 * Answers questions of the form:
 *   "What do we know about <subject>?"
 *   "Tell me about <subject>."
 *   "What are the facts on <subject>?"
 *   "What's known about <subject>?"
 *
 * Reads from `instinct_org_facts` (the org-wide correction store
 * populated by the learning loop — see learning.ts). Returns the
 * active (non-superseded) facts plus a formatted answer string the
 * chat surface can render directly.
 *
 * Why this is the right "first tool":
 *   - Read-only (no mutation, no confirmation flow needed).
 *   - Touches a table that's already RLS-isolated to the workspace.
 *   - Zero external dependencies (no Microsoft Graph, no LLM, no
 *     vendor adapter).
 *   - High-signal: corrects exactly the class of hallucination the
 *     learning loop captures.
 */

import { z } from "zod";
import { findRelevantFacts } from "@/lib/assistant/learning";
import { registerTool } from "./registry";
import type { ToolDef, ToolSuccess } from "./types";

const ParamSchema = z.object({
  subject: z.string().min(2).max(120),
});
type Params = z.infer<typeof ParamSchema>;

interface OrgFactsData {
  subject: string;
  factCount: number;
  facts: Array<{
    id: string;
    subject: string;
    attribute: string;
    value: string;
  }>;
}

/** Regex set for the intent classifier. First-match-wins on the message. */
const INTENT_PATTERNS: RegExp[] = [
  /\bwhat\s+do\s+(?:we|you)\s+know\s+about\s+(.{2,80}?)\??$/i,
  /\btell\s+me\s+about\s+(.{2,80}?)\??$/i,
  /\bwhat\s+(?:are|is)\s+the\s+facts?\s+(?:on|about|for)\s+(.{2,80}?)\??$/i,
  /\bwhat'?s\s+known\s+about\s+(.{2,80}?)\??$/i,
  /* "do we have anything on X" USED TO BE HERE, and it was the wrong question
     for this tool. This reads instinct_org_facts, which holds facts somebody
     verified by hand and is empty for almost every subject. Measured
     2026-08-28: "do we have anything on the porsche program" was claimed here
     and answered "I don't have any verified facts about the porsche program
     yet", while the Brain held the client's entire SharePoint on it.

     "What do we know about X" is a question about what we have established.
     "Do we have anything on X" is a question about whether anything exists at
     all, and the honest place to answer it is search, which can see the
     documents. The split is the words people chose, not a technicality. */
];

function matchOrgFactsIntent(message: string): Params | null {
  const trimmed = message.trim();
  for (const re of INTENT_PATTERNS) {
    const m = re.exec(trimmed);
    if (m && m[1]) {
      const subject = m[1].trim().replace(/[?.!]+$/g, "");
      if (subject.length >= 2) return { subject };
    }
  }
  return null;
}

export const getOrgFactsTool: ToolDef<Params, OrgFactsData> = {
  name: "get_org_facts",
  description:
    "Retrieve verified facts the team has provided about a subject (project, client, person, product). Reads from instinct_org_facts.",
  paramSchema: ParamSchema,
  capability: "*",
  matchIntent: matchOrgFactsIntent,
  async handler({ subject }, _ctx): Promise<ToolSuccess<OrgFactsData> | { ok: false; code: "internal"; message: string }> {
    try {
      const facts = await findRelevantFacts(subject, 10);
      const data: OrgFactsData = {
        subject,
        factCount: facts.length,
        facts: facts.map((f) => ({
          id: f.id,
          subject: f.subject,
          attribute: f.attribute,
          value: f.value,
        })),
      };
      const answer = formatAnswer(subject, facts);
      return {
        ok: true,
        data,
        answer,
        sources: facts.slice(0, 5).map((f) => ({
          id: f.id,
          title: `${f.subject} → ${f.attribute}`,
          url: `/knowledge?fact=${encodeURIComponent(f.id)}`,
          type: "knowledge" as const,
        })),
      };
    } catch (err) {
      return {
        ok: false,
        code: "internal",
        message: `get_org_facts handler error: ${(err as Error)?.message ?? "unknown"}`,
      };
    }
  },
};

/** Build the user-facing markdown answer. */
function formatAnswer(
  subject: string,
  facts: Array<{ subject: string; attribute: string; value: string }>,
): string {
  if (facts.length === 0) {
    return `I don't have any verified facts about "${subject}" yet. Once someone corrects me on a related answer, that correction will land here.`;
  }
  const lines = [`Here's what the team has verified about "${subject}":`, ""];
  for (const f of facts) {
    lines.push(`- **${f.subject}** → **${f.attribute}**: ${f.value}`);
  }
  return lines.join("\n");
}

/* Side-effect registration at module load. Importing this file is
 * enough to make the tool available to the dispatcher. */
registerTool(getOrgFactsTool);
