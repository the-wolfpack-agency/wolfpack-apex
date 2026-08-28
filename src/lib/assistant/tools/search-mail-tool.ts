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
import { getValidToken } from "@/lib/microsoft-graph";
import { registerTool } from "./registry";
import type { ToolDef, ToolResult } from "./types";

const ParamSchema = z.object({
  from: z.string().min(1).max(120).optional(),
  to: z.string().min(1).max(120).optional(),
  topic: z.string().min(1).max(120).optional(),
}).refine((d) => !!(d.from || d.to || d.topic), {
  message: "mail search needs at least one of 'from', 'to', or 'topic'",
});
type Params = z.infer<typeof ParamSchema>;

const PATTERNS: Array<{ re: RegExp; build(m: RegExpExecArray): Params | null }> = [
  /* Most-specific first: from + topic, to + topic, from + to. */
  {
    re: /\b(?:find|search|look\s+up|show)\s+(?:my\s+)?emails?\s+from\s+(.+?)\s+about\s+(.+?)\??$/i,
    build: (m) => ({ from: m[1].trim(), topic: m[2].trim() }),
  },
  {
    re: /\b(?:find|search|look\s+up|show)\s+(?:my\s+)?emails?\s+to\s+(.+?)\s+about\s+(.+?)\??$/i,
    build: (m) => ({ to: m[1].trim(), topic: m[2].trim() }),
  },
  {
    re: /\b(?:find|search|look\s+up|show)\s+(?:my\s+)?emails?\s+from\s+(.+?)\s+to\s+(.+?)\??$/i,
    build: (m) => ({ from: m[1].trim(), to: m[2].trim() }),
  },
  /* Single-slot from / to. */
  {
    re: /\b(?:find|search|look\s+up|show)\s+(?:my\s+)?emails?\s+from\s+(.+?)\??$/i,
    build: (m) => ({ from: m[1].trim() }),
  },
  {
    re: /\b(?:find|search|look\s+up|show)\s+(?:my\s+)?emails?\s+to\s+(.+?)\??$/i,
    build: (m) => ({ to: m[1].trim() }),
  },
  /* Topic-only. */
  {
    re: /\b(?:find|search|look\s+up|show|any)\s+emails?\s+about\s+(.+?)\??$/i,
    build: (m) => ({ topic: m[1].trim() }),
  },
  /* "did X email me/us about Y" — incoming. */
  {
    re: /\b(?:did|has)\s+(.+?)\s+email(?:ed)?\s+(?:me|us)\s+(?:about\s+)?(.+?)?\??$/i,
    build: (m) =>
      m[2]
        ? { from: m[1].trim(), topic: m[2].trim() }
        : { from: m[1].trim() },
  },
  /* "did I email X about Y" — outgoing. */
  {
    re: /\b(?:did|have)\s+(?:i|we)\s+email(?:ed)?\s+(.+?)\s+about\s+(.+?)\??$/i,
    build: (m) => ({ to: m[1].trim(), topic: m[2].trim() }),
  },
  {
    re: /\b(?:did|have)\s+(?:i|we)\s+email(?:ed)?\s+(.+?)\??$/i,
    build: (m) => ({ to: m[1].trim() }),
  },
];

function matchMailIntent(message: string): Params | null {
  const trimmed = message.trim();
  for (const { re, build } of PATTERNS) {
    const m = re.exec(trimmed);
    if (m) {
      const built = build(m);
      if (built && (built.from || built.to || built.topic)) return built;
    }
  }
  return null;
}

/**
 * Whether we can reach this person's mailbox at all.
 *
 * Separate from the search itself so the empty case can say which kind of
 * empty it is. A token that exists but is refused by Graph reports as
 * unreachable too, which is the honest answer: we could not read the mailbox,
 * whatever the reason.
 */
async function mailboxReachable(userId: string): Promise<boolean> {
  const auth = await getValidToken(userId).catch(() => null);
  return Boolean(auth?.accessToken);
}

export const searchMailTool: ToolDef<Params, MailSearchResult> = {
  name: "search_mail",
  description:
    "Search the requesting user's Microsoft 365 mailbox. Filters by sender, topic, or both.",
  paramSchema: ParamSchema,
  capability: "*",
  /* "CHECK MY EMAIL" IS THE COMMONEST STEP ANYBODY DESCRIBES, and this tool
     could not appear in a chain at all. Its rule spans three fields - at least
     one of from, to or topic - so it fails at the root with no path, and the
     day planner had nothing to ask for. Topic is the useful one to ask: people
     describing a morning mean "anything about X", not a named sender. */
  chainAsk: { topic: "What should I look for in your mail? A topic, or a person's name." },
  matchIntent: matchMailIntent,
  async handler(params, ctx): Promise<ToolResult<MailSearchResult>> {
    try {
      const result = await runMailSearch({
        userId: ctx.userId,
        from: params.from,
        to: params.to,
        topic: params.topic,
        limit: 10,
      });
      if (!result || (result as { count?: number }).count === 0) {
        /* AN UNCONNECTED MAILBOX IS NOT AN EMPTY ONE.
           The matcher returns [] when getValidToken finds no token, which is
           the same [] it returns when the search genuinely found nothing, and
           this rendered both as "I didn't find any emails about pricing". That
           is the shape that told everybody they had no tasks for months: the
           reader cannot tell "nothing matched" from "we never looked", and
           only one of them is worth acting on.

           Checked only when the result is empty, so a normal answer costs
           nothing extra. */
        const connected = await mailboxReachable(ctx.userId);
        if (!connected) {
          return {
            ok: true,
            data: { messages: [], count: 0 } as unknown as MailSearchResult,
            answer:
              "Microsoft is not connected yet, so I cannot read your mail. Connect it in Settings and I will be able to search it.",
          };
        }
      }
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

function qualifierString(p: Params): string {
  const parts: string[] = [];
  if (p.from) parts.push(`from "${p.from}"`);
  if (p.to) parts.push(`to "${p.to}"`);
  if (p.topic) parts.push(`about "${p.topic}"`);
  return parts.join(" ");
}

function buildEmptyMessage(p: Params): string {
  return `I didn't find any emails ${qualifierString(p)}.`;
}

function formatFromCount(p: Params, count: number): string {
  if (count === 0) return buildEmptyMessage(p);
  return `Found ${count} email${count === 1 ? "" : "s"} ${qualifierString(p)}.`;
}

registerTool(searchMailTool);
