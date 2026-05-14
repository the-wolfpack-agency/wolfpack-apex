/**
 * search_mail tool — wraps runMailSearch().
 *
 * Answers questions of the form:
 *   "Find emails from <sender>"
 *   "Any emails about <topic>?"
 *   "Search emails from <sender> about <topic>"
 *
 * Reads the requesting user's Microsoft Graph mail via delegated token.
 */

import { z } from "zod";
import { runMailSearch, type MailSearchResult } from "./mail-search";
import { registerTool } from "./registry";
import type { ToolDef, ToolResult } from "./types";

const ParamSchema = z.object({
  from: z.string().min(1).max(120).optional(),
  topic: z.string().min(1).max(120).optional(),
}).refine((d) => !!(d.from || d.topic), {
  message: "mail search needs at least one of 'from' or 'topic'",
});
type Params = z.infer<typeof ParamSchema>;

const PATTERNS: Array<{ re: RegExp; build(m: RegExpExecArray): Params | null }> = [
  {
    re: /\b(?:find|search|look\s+up|show)\s+(?:my\s+)?emails?\s+from\s+(.+?)\s+about\s+(.+?)\??$/i,
    build: (m) => ({ from: m[1].trim(), topic: m[2].trim() }),
  },
  {
    re: /\b(?:find|search|look\s+up|show)\s+(?:my\s+)?emails?\s+from\s+(.+?)\??$/i,
    build: (m) => ({ from: m[1].trim() }),
  },
  {
    re: /\b(?:find|search|look\s+up|show|any)\s+emails?\s+about\s+(.+?)\??$/i,
    build: (m) => ({ topic: m[1].trim() }),
  },
  {
    re: /\b(?:did|has)\s+(.+?)\s+email(?:ed)?\s+(?:me|us)\s+(?:about\s+)?(.+?)?\??$/i,
    build: (m) =>
      m[2]
        ? { from: m[1].trim(), topic: m[2].trim() }
        : { from: m[1].trim() },
  },
];

function matchMailIntent(message: string): Params | null {
  const trimmed = message.trim();
  for (const { re, build } of PATTERNS) {
    const m = re.exec(trimmed);
    if (m) {
      const built = build(m);
      if (built && (built.from || built.topic)) return built;
    }
  }
  return null;
}

export const searchMailTool: ToolDef<Params, MailSearchResult> = {
  name: "search_mail",
  description:
    "Search the requesting user's Microsoft 365 mailbox. Filters by sender, topic, or both.",
  paramSchema: ParamSchema,
  capability: "*",
  matchIntent: matchMailIntent,
  async handler(params, ctx): Promise<ToolResult<MailSearchResult>> {
    try {
      const result = await runMailSearch({
        userId: ctx.userId,
        from: params.from,
        topic: params.topic,
        limit: 10,
      });
      if (!result) {
        return {
          ok: true,
          data: { messages: [], count: 0 } as unknown as MailSearchResult,
          answer: buildEmptyMessage(params),
        };
      }
      const ans =
        (result as { answer?: string }).answer ??
        formatFromCount(params, (result as { count?: number }).count ?? 0);
      return { ok: true, data: result, answer: ans };
    } catch (err) {
      return {
        ok: false,
        code: "internal",
        message: `search_mail error: ${(err as Error)?.message ?? "unknown"}`,
      };
    }
  },
};

function buildEmptyMessage(p: Params): string {
  if (p.from && p.topic) return `I didn't find any emails from "${p.from}" about "${p.topic}".`;
  if (p.from) return `I didn't find any emails from "${p.from}".`;
  return `I didn't find any emails about "${p.topic}".`;
}

function formatFromCount(p: Params, count: number): string {
  if (count === 0) return buildEmptyMessage(p);
  const whoWhat =
    p.from && p.topic
      ? `from "${p.from}" about "${p.topic}"`
      : p.from
      ? `from "${p.from}"`
      : `about "${p.topic}"`;
  return `Found ${count} email${count === 1 ? "" : "s"} ${whoWhat}.`;
}

registerTool(searchMailTool);
