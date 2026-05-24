/**
 * cross_tool_insights — fan across integrations (calendar, email,
 * GitHub, Vercel, etc.) to surface signals no single tool can see.
 * Rule-based detection per generator (zero AI tokens for the patterns).
 *
 * Trigger phrases:
 *   "show me cross-tool insights"
 *   "what insights do I have"
 *   "what should I know"
 *   "give me efficiency insights"
 */

import { z } from "zod";
import { trackEvent } from "@/lib/analytics";
import { registerTool } from "./registry";
import type { ToolDef, ToolResult } from "./types";
import type { WidgetSpec } from "@/lib/assistant/widgets/types";
import { runAllInsightGenerators } from "@/lib/insights/cross-tool-generators";

const ParamSchema = z.object({
  lookbackDays: z.number().int().min(1).max(90).default(30),
});
type Params = z.infer<typeof ParamSchema>;

interface CrossToolInsightsData {
  kind: "cross_tool_insights";
  insightCount: number;
  generatorOutcomes: Array<{ name: string; count: number; ok: boolean }>;
  durationMs: number;
}

const INTENT_RE =
  /\b(cross[- ]?tool|cross[- ]?source|cross[- ]?cutting|efficiency)\s+insights?\b|\binsights?\s+across\s+(my\s+)?(tools?|integrations?)\b|\bwhat\s+should\s+i\s+know\b|\bwhat\s+insights?\s+(do\s+i\s+have|are\s+there)\b/i;

function matchIntent(message: string): Params | null {
  if (!INTENT_RE.test(message.trim())) return null;
  return { lookbackDays: 30 };
}

export const crossToolInsightsWidgetTool: ToolDef<Params, CrossToolInsightsData> = {
  name: "cross_tool_insights_widget",
  description:
    "Fan across all connected integrations (calendar, email, GitHub, Vercel) and surface cross-tool efficiency insights using rule-based pattern detection. Zero AI tokens for the patterns themselves.",
  paramSchema: ParamSchema,
  capability: "*",
  matchIntent,
  async handler(params, ctx): Promise<ToolResult<CrossToolInsightsData>> {
    const started = Date.now();
    /* MS-Graph-backed generators are deferred to v2 (see cross-tool-
     * generators.ts). v1 ships GitHub + Vercel patterns which don't
     * need a token here. */
    const { insights, generatorOutcomes } = await runAllInsightGenerators({
      userId: ctx.userId,
      userRole: ctx.userRole,
      lookbackDays: params.lookbackDays,
    });
    const durationMs = Date.now() - started;

    trackEvent("assistant.widget_offered", ctx.userId, ctx.userRole, {
      widget_kind: "cross_tool_insights",
      insight_count: insights.length,
      generator_count: generatorOutcomes.length,
      duration_ms: durationMs,
      ok: true,
    });

    const spec: WidgetSpec = {
      kind: "cross_tool_insights",
      title:
        insights.length === 0
          ? "No cross-tool insights right now"
          : `${insights.length} cross-tool insight${insights.length === 1 ? "" : "s"}`,
      subtitle:
        insights.length === 0
          ? `Ran ${generatorOutcomes.filter((g) => g.ok).length} generators across ${generatorOutcomes.length} patterns. All clean.`
          : `Across ${new Set(insights.flatMap((i) => i.sources)).size} integration${
              new Set(insights.flatMap((i) => i.sources)).size === 1 ? "" : "s"
            }, ${generatorOutcomes.filter((g) => g.ok).length} of ${generatorOutcomes.length} patterns checked.`,
      lookbackDays: params.lookbackDays,
      items: insights.map((i) => ({
        id: i.id,
        generator: i.generator,
        severity: i.severity,
        signalStrength: i.signalStrength,
        title: i.title,
        detail: i.detail ?? null,
        action: i.action ?? null,
        sources: i.sources,
      })),
      generatorOutcomes,
    };

    const answer =
      insights.length === 0
        ? "No cross-tool insights to flag right now. I ran all generators across your connected integrations and nothing crossed the signal threshold."
        : `Found ${insights.length} cross-tool insight${insights.length === 1 ? "" : "s"} (${
            insights.filter((i) => i.severity === "high").length
          } high-signal). Each one combines data from at least two of your tools.`;

    return {
      ok: true,
      data: {
        kind: "cross_tool_insights",
        insightCount: insights.length,
        generatorOutcomes,
        durationMs,
      },
      answer,
      widget: spec,
    };
  },
};

registerTool(crossToolInsightsWidgetTool);
