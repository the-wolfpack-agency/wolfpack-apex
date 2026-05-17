/**
 * good_morning_widget — renders the Dashboard's "Good morning" panel
 * inline in the chat. Same data source (generateBriefing), trimmed to
 * the three highest-signal sections: greeting + summary, today's
 * schedule, action items.
 *
 * Trigger phrases:
 *   "good morning" / "morning" / "morning briefing" / "morning brief"
 *   "daily briefing" / "what's on for today" / "my day"
 *
 * Implementation note: we deliberately don't include the financials,
 * client-attention, or team-highlights sections in the chat widget.
 * Those are richer surfaces that earn their space on the dashboard;
 * the chat surface is for the at-a-glance trio.
 */

import { z } from "zod";
import { trackEvent } from "@/lib/analytics";
import { generateBriefing } from "@/lib/morning-briefing";
import { registerTool } from "./registry";
import type { ToolDef, ToolResult } from "./types";
import type {
  GoodMorningWidgetSpec,
  GoodMorningEvent,
  GoodMorningActionItem,
} from "@/lib/assistant/widgets/types";

const ParamSchema = z.object({});
type Params = z.infer<typeof ParamSchema>;

interface GoodMorningData {
  kind: "good_morning";
  eventCount: number;
  actionItemCount: number;
}

const INTENT_RE =
  /^(?:good\s+morning|morning|morning\s+brief(?:ing)?|daily\s+brief(?:ing)?|what'?s\s+on\s+(?:for\s+)?today|my\s+day|today'?s\s+brief(?:ing)?)[\s.?!]*$/i;

function matchGoodMorningIntent(message: string): Params | null {
  if (!INTENT_RE.test(message.trim())) return null;
  return {};
}

export const goodMorningWidgetTool: ToolDef<Params, GoodMorningData> = {
  name: "good_morning_widget",
  description:
    "Render the daily-briefing panel inline in chat: greeting, today's meetings, and action items. Same data source as the dashboard's Good morning card.",
  paramSchema: ParamSchema,
  capability: "*",
  matchIntent: matchGoodMorningIntent,
  async handler(_params, ctx): Promise<ToolResult<GoodMorningData>> {
    let spec: GoodMorningWidgetSpec;
    let answer: string;

    try {
      const userName = ctx.userEmail?.split("@")[0] ?? "there";
      const briefing = await generateBriefing(ctx.userId, ctx.userRole, { userName });

      const events: GoodMorningEvent[] = briefing.calendar.events.map((e) => ({
        subject: e.subject,
        startTime: e.startTime,
        endTime: e.endTime,
        attendees: e.attendees ?? [],
        location: e.location,
      }));

      const actionItems: GoodMorningActionItem[] = briefing.actionItems.map((a) => ({
        priority: a.priority,
        text: a.text,
        context: a.context,
        link: a.link,
        source: a.source,
      }));

      spec = {
        kind: "good_morning",
        greeting: briefing.greeting,
        summary: briefing.summary,
        schedule: { eventCount: briefing.calendar.eventCount, events },
        actionItems,
        connected: !briefing.notConnected,
      };

      const eventCount = events.length;
      const actionCount = actionItems.length;
      answer =
        eventCount === 0 && actionCount === 0
          ? "Your day's clear. Here's the panel."
          : `${eventCount} meeting${eventCount === 1 ? "" : "s"} today, ${actionCount} action item${actionCount === 1 ? "" : "s"}.`;
    } catch (err) {
      console.warn("[good-morning-widget] generateBriefing failed:", (err as Error).message);
      spec = {
        kind: "good_morning",
        greeting: "Good morning",
        summary: "I couldn't pull your briefing right now. Open the dashboard to retry.",
        schedule: { eventCount: 0, events: [] },
        actionItems: [],
        connected: false,
      };
      answer = "Couldn't reach your accounts. Open the dashboard to retry.";
    }

    trackEvent("assistant.widget_offered", ctx.userId, ctx.userRole, {
      widget_kind: "good_morning",
      event_count: spec.schedule.events.length,
      action_count: spec.actionItems.length,
      connected: spec.connected,
    });

    return {
      ok: true,
      data: {
        kind: "good_morning",
        eventCount: spec.schedule.events.length,
        actionItemCount: spec.actionItems.length,
      },
      answer,
      widget: spec,
    };
  },
};

registerTool(goodMorningWidgetTool);
