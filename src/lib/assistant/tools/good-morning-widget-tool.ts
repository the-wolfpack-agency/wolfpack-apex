/**
 * good_morning_widget — renders the Dashboard's daily-briefing panel
 * inline in the chat. Same data source (generateBriefing), trimmed to
 * the three highest-signal sections: greeting + summary, today's
 * schedule, action items.
 *
 * Trigger phrases (time-of-day neutral; the greeting text inside the
 * widget already adapts via getGreeting):
 *   "briefing" / "brief me" / "my brief" / "daily briefing"
 *   "my day" / "today's agenda" / "my agenda" / "today's briefing"
 *   "what's on for today" / "what's on today"
 *   "good morning" / "good afternoon" / "good evening" / "morning"
 *
 * Implementation note: we deliberately don't include the financials,
 * client-attention, or team-highlights sections in the chat widget.
 * Those are richer surfaces that earn their space on the dashboard;
 * the chat surface is for the at-a-glance trio.
 */

import { z } from "zod";
import { trackEvent } from "@/lib/analytics";
import { safeQuery } from "@/lib/db";
import { generateBriefing } from "@/lib/morning-briefing";
import { listUpcomingMeetings, pickDefaultMeeting } from "@/lib/meetings/upcoming";
import { registerTool } from "./registry";
import type { ToolDef, ToolResult } from "./types";
import type {
  GoodMorningWidgetSpec,
  GoodMorningEvent,
  GoodMorningActionItem,
  GoodMorningPreBrief,
  GoodMorningPreBriefMeeting,
} from "@/lib/assistant/widgets/types";

const PREBRIEF_LOOKAHEAD_HOURS = 48;

/**
 * Resolve the user's first name for the greeting. The dashboard's
 * /api/briefing route pulls `user.name.split(" ")[0]` from the JWT;
 * the tool context doesn't carry that, so look it up by userId in
 * instinct_team_members. Falls back to the email handle, then to
 * "there" if nothing's available.
 */
async function resolveUserFirstName(
  userId: string,
  userEmail: string | undefined,
): Promise<string> {
  try {
    const { rows } = await safeQuery<{ name: string | null }>(
      `SELECT name FROM instinct_team_members WHERE id = $1 LIMIT 1`,
      [userId],
    );
    const name = rows[0]?.name;
    if (name) {
      const first = name.split(" ")[0]?.trim();
      if (first) return first;
    }
  } catch {
    /* DB miss / column missing — fall through to email handle. */
  }
  const handle = userEmail?.split("@")[0]?.trim();
  return handle || "there";
}

const ParamSchema = z.object({});
type Params = z.infer<typeof ParamSchema>;

interface GoodMorningData {
  kind: "good_morning";
  eventCount: number;
  actionItemCount: number;
}

const INTENT_RE =
  /^(?:brief(?:ing)?|brief\s+me|my\s+brief(?:ing)?|daily\s+brief(?:ing)?|today'?s\s+brief(?:ing)?|today'?s\s+agenda|my\s+agenda|my\s+day|what'?s\s+on\s+(?:for\s+)?today|good\s+(?:morning|afternoon|evening)|morning|afternoon\s+brief(?:ing)?)[\s.?!]*$/i;

function matchGoodMorningIntent(message: string): Params | null {
  if (!INTENT_RE.test(message.trim())) return null;
  return {};
}

export const goodMorningWidgetTool: ToolDef<Params, GoodMorningData> = {
  name: "good_morning_widget",
  description:
    "Render the daily-briefing panel inline in chat at any time of day: time-aware greeting, today's meetings, and action items. Same data source as the dashboard's briefing card.",
  paramSchema: ParamSchema,
  capability: "*",
  matchIntent: matchGoodMorningIntent,
  async handler(_params, ctx): Promise<ToolResult<GoodMorningData>> {
    let spec: GoodMorningWidgetSpec;
    let answer: string;

    try {
      const userName = await resolveUserFirstName(ctx.userId, ctx.userEmail);
      /* Briefing + upcoming-meetings (next 48h) fetched in parallel —
       * they hit different Graph endpoints and the chat surface gets
       * both panels at once. */
      const [briefing, upcoming] = await Promise.all([
        generateBriefing(ctx.userId, ctx.userRole, { userName }),
        listUpcomingMeetings(ctx.userId, { lookaheadHours: PREBRIEF_LOOKAHEAD_HOURS }).catch(
          () => [],
        ),
      ]);

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

      const prebriefMeetings: GoodMorningPreBriefMeeting[] = upcoming.map((m) => ({
        id: m.id,
        subject: m.subject,
        start: m.start,
        end: m.end,
        location: m.location,
        attendees: m.attendees,
        isOnlineMeeting: m.isOnlineMeeting,
        minutesUntil: m.minutesUntil,
        inProgress: m.inProgress,
      }));
      const defaultMeeting = pickDefaultMeeting(upcoming);
      const preBrief: GoodMorningPreBrief = {
        defaultMeetingId: defaultMeeting?.id ?? null,
        meetings: prebriefMeetings,
        lookaheadHours: PREBRIEF_LOOKAHEAD_HOURS,
      };

      spec = {
        kind: "good_morning",
        greeting: briefing.greeting,
        summary: briefing.summary,
        schedule: { eventCount: briefing.calendar.eventCount, events },
        actionItems,
        preBrief,
        connected: !briefing.notConnected,
      };

      const eventCount = events.length;
      const actionCount = actionItems.length;
      const prebriefSuffix = defaultMeeting
        ? `, next: ${defaultMeeting.subject}`
        : "";
      answer =
        eventCount === 0 && actionCount === 0 && !defaultMeeting
          ? "Your day's clear. Here's the panel."
          : `${eventCount} meeting${eventCount === 1 ? "" : "s"} today, ${actionCount} action item${actionCount === 1 ? "" : "s"}${prebriefSuffix}.`;
    } catch (err) {
      console.warn("[good-morning-widget] generateBriefing failed:", (err as Error).message);
      spec = {
        kind: "good_morning",
        greeting: "Good morning",
        summary: "I couldn't pull your briefing right now. Open the dashboard to retry.",
        schedule: { eventCount: 0, events: [] },
        actionItems: [],
        preBrief: {
          defaultMeetingId: null,
          meetings: [],
          lookaheadHours: PREBRIEF_LOOKAHEAD_HOURS,
        },
        connected: false,
      };
      answer = "Couldn't reach your accounts. Open the dashboard to retry.";
    }

    trackEvent("assistant.widget_offered", ctx.userId, ctx.userRole, {
      widget_kind: "good_morning",
      event_count: spec.schedule.events.length,
      action_count: spec.actionItems.length,
      prebrief_count: spec.preBrief?.meetings.length ?? 0,
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
