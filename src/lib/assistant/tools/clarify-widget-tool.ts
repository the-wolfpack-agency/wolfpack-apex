/**
 * clarify_widget — typo / ambiguity catcher. Runs as a high-priority
 * intent for short single-token queries that LOOK like typos of
 * known commands. Instead of generating an LLM "did you mean…?"
 * response (which wastes tokens and historically poisoned the
 * knowledge cache), we surface 1-tap suggestion chips.
 *
 * Detection is intentionally narrow: 1-2 token query AND Damerau-
 * Levenshtein distance ≤ 2 from a curated KNOWN_TERMS list AND no
 * other tool intent matched. Anything broader risks intercepting
 * legitimate queries.
 *
 * Zero AI tokens.
 */

import { z } from "zod";
import { trackEvent } from "@/lib/analytics";
import { registerTool } from "./registry";
import type { ToolDef, ToolResult } from "./types";
import type {
  WidgetSpec,
  ClarifySuggestion,
} from "@/lib/assistant/widgets/types";

const ParamSchema = z.object({
  originalQuery: z.string(),
  suggestions: z.array(
    z.object({ label: z.string(), query: z.string(), hint: z.string().optional() }),
  ),
});
type Params = z.infer<typeof ParamSchema>;

interface ClarifyData {
  kind: "clarify";
  suggestionCount: number;
}

/* Curated list of "things the assistant can actually do" the user
 * might mistype. Each entry pairs the canonical query (what we'll
 * re-send on chip-click) with the visible label and a hint. Add new
 * entries here when a new high-value command ships. */
const KNOWN_TERMS: Array<{ canonical: string; label: string; hint: string }> = [
  { canonical: "insights", label: "insights", hint: "Cross-tool insights across all your integrations" },
  { canonical: "calendar", label: "calendar", hint: "What's on your calendar today" },
  { canonical: "emails", label: "emails", hint: "Your recent inbox" },
  { canonical: "deploys", label: "deploys", hint: "Recent Vercel deployments" },
  { canonical: "integrations", label: "integrations", hint: "Everything the assistant can connect to" },
  { canonical: "tasks", label: "tasks", hint: "Your open tasks" },
  { canonical: "messages", label: "messages", hint: "Your recent Teams messages" },
  { canonical: "pull requests", label: "pull requests", hint: "Open PRs across the org" },
  { canonical: "issues", label: "issues", hint: "Open GitHub issues across the org" },
];

/** Damerau-Levenshtein distance — handles single insertion, deletion,
 *  substitution, and ADJACENT transposition ("teh" ↔ "the"). Plain
 *  Levenshtein would miss the swap. */
function damerauLevenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const d: number[][] = Array.from({ length: m + 1 }, () =>
    new Array(n + 1).fill(0),
  );
  for (let i = 0; i <= m; i++) d[i][0] = i;
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(
        d[i - 1][j] + 1, // delete
        d[i][j - 1] + 1, // insert
        d[i - 1][j - 1] + cost, // substitute
      );
      if (
        i > 1 &&
        j > 1 &&
        a[i - 1] === b[j - 2] &&
        a[i - 2] === b[j - 1]
      ) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1); // transposition
      }
    }
  }
  return d[m][n];
}

/** Token count after collapsing whitespace + dropping trailing punct. */
function tokenCount(q: string): number {
  return q.trim().replace(/[!?.]+$/, "").split(/\s+/).filter(Boolean).length;
}

export function findClarifyMatches(query: string): ClarifySuggestion[] {
  const trimmed = query.trim().toLowerCase().replace(/[!?.]+$/, "");
  if (!trimmed) return [];
  /* Exact matches don't need clarifying — they go to the right tool. */
  if (KNOWN_TERMS.some((k) => k.canonical === trimmed)) return [];
  /* Only intercept short queries; long ones are intent-bearing and
   * belong to the LLM/RAG path. */
  if (tokenCount(trimmed) > 2) return [];
  /* Score every known term by distance. Ratio threshold rather than
   * raw distance so "ai" doesn't match "issues". */
  const scored = KNOWN_TERMS.map((k) => {
    const dist = damerauLevenshtein(trimmed, k.canonical);
    const ratio = dist / Math.max(trimmed.length, k.canonical.length);
    return { ...k, dist, ratio };
  })
    .filter((s) => s.dist <= 2 && s.ratio <= 0.34)
    .sort((a, b) => a.ratio - b.ratio);
  if (scored.length === 0) return [];
  /* Cap at 3 suggestions; chip list shouldn't dominate the chat. */
  return scored.slice(0, 3).map((s) => ({
    label: s.label,
    query: s.canonical,
    hint: s.hint,
  }));
}

function matchIntent(message: string): Params | null {
  const suggestions = findClarifyMatches(message);
  if (suggestions.length === 0) return null;
  return { originalQuery: message.trim(), suggestions };
}

export const clarifyWidgetTool: ToolDef<Params, ClarifyData> = {
  name: "clarify_widget",
  description:
    "Surface 1-tap clarification chips when a user query looks like a typo of a known command. Zero AI tokens; runs before the LLM path.",
  paramSchema: ParamSchema,
  capability: "*",
  matchIntent,
  async handler(params, ctx): Promise<ToolResult<ClarifyData>> {
    trackEvent("assistant.widget_offered", ctx.userId, ctx.userRole, {
      widget_kind: "clarify",
      suggestion_count: params.suggestions.length,
      original_query: params.originalQuery,
      ok: true,
    });
    const spec: WidgetSpec = {
      kind: "clarify",
      title: "Did you mean…?",
      originalQuery: params.originalQuery,
      suggestions: params.suggestions,
    };
    const answer = `Did you mean one of these? Tap a chip to run it.`;
    return {
      ok: true,
      data: { kind: "clarify", suggestionCount: params.suggestions.length },
      answer,
      widget: spec,
    };
  },
};

registerTool(clarifyWidgetTool);
