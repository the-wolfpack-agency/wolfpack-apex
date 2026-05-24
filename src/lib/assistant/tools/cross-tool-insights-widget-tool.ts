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
    const { insights, generatorOutcomes } = await runAllInsightGenerators({
      userId: ctx.userId,
      userRole: ctx.userRole,
      lookbackDays: params.lookbackDays,
    });
    const durationMs = Date.now() - started;

    /* Sort the cross-tool items (≥2 sources) ahead of single-source
     * items so the widget leads with the "only Instinct can see this"
     * material. Within each band the aggregator already sorted by
     * severity then signalStrength. */
    const sorted = [...insights].sort((a, b) => {
      const aCross = a.sources.length >= 2 ? 0 : 1;
      const bCross = b.sources.length >= 2 ? 0 : 1;
      return aCross - bCross;
    });
    const crossToolCount = sorted.filter((i) => i.sources.length >= 2).length;
    const highCount = sorted.filter((i) => i.severity === "high").length;
    const integrationCount = new Set(sorted.flatMap((i) => i.sources)).size;

    trackEvent("assistant.widget_offered", ctx.userId, ctx.userRole, {
      widget_kind: "cross_tool_insights",
      insight_count: sorted.length,
      cross_tool_count: crossToolCount,
      high_signal_count: highCount,
      generator_count: generatorOutcomes.length,
      duration_ms: durationMs,
      ok: true,
    });

    const spec: WidgetSpec = {
      kind: "cross_tool_insights",
      title:
        sorted.length === 0
          ? "No cross-tool insights right now"
          : crossToolCount > 0
            ? `${crossToolCount} cross-tool insight${crossToolCount === 1 ? "" : "s"}${sorted.length > crossToolCount ? ` (+ ${sorted.length - crossToolCount} single-tool)` : ""}`
            : `${sorted.length} single-tool insight${sorted.length === 1 ? "" : "s"}`,
      subtitle:
        sorted.length === 0
          ? `Ran ${generatorOutcomes.filter((g) => g.ok).length} of ${generatorOutcomes.length} patterns. All clean — connect more tools (calendar, email) for richer cross-tool signal.`
          : `Across ${integrationCount} integration${integrationCount === 1 ? "" : "s"}, ${generatorOutcomes.filter((g) => g.ok).length} of ${generatorOutcomes.length} patterns checked.`,
      lookbackDays: params.lookbackDays,
      items: sorted.map((i) => ({
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
      sorted.length === 0
        ? "No cross-tool insights to flag right now. I ran all generators across your connected integrations and nothing crossed the signal threshold."
        : crossToolCount > 0
          ? `Found ${crossToolCount} cross-tool insight${crossToolCount === 1 ? "" : "s"} (${highCount} high-signal). Cross-tool means combining data from 2+ of your integrations — patterns no single tool can see.`
          : `Found ${sorted.length} insight${sorted.length === 1 ? "" : "s"} (${highCount} high-signal). All from a single tool — connect calendar/email for cross-tool patterns (e.g. PRs from people you're meeting this week).`;

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
