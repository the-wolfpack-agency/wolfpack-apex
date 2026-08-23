/**
 * schedule_health: "where are meetings hurting us", "when should I do
 * focus work", "what are my ideal times of day".
 *
 * The human half of the operating picture. Every other analysis surface
 * we have reads systems; this one reads the thing those systems are
 * competing for, which is somebody's week.
 *
 * Zero AI tokens. The report is arithmetic over a calendar, and a
 * person defending a Thursday morning needs a number they can point at
 * rather than a paragraph a model wrote about their habits.
 */

import { z } from "zod";
import { trackEvent } from "@/lib/analytics";
import { registerTool } from "./registry";
import type { ToolDef, ToolResult } from "./types";
import {
  analyseSchedule,
  renderSchedule,
  DEFAULT_HOURS,
  type ScheduleEvent,
} from "@/lib/insights/schedule-health";

const ParamSchema = z.object({
  /** Window to analyse. Two weeks by default: one is too noisy to
      generalise from, a quarter buries a change that just started. */
  days: z.number().int().min(7).max(90).default(14),
  /** Look back over what happened, or forward at what is committed. */
  direction: z.enum(["past", "ahead"]).default("past"),
});
type Params = z.infer<typeof ParamSchema>;

interface ScheduleHealthData {
  days: number;
  direction: "past" | "ahead";
  meetings: number;
  usableBlocks: number;
  strandedHours: number;
}

const INTENT_RE =
  /\b(?:where\s+are\s+)?(?:my\s+|our\s+)?meetings?\s+(?:are\s+)?(?:doing\s+more\s+harm|hurting|costing)\b|\bschedule\s+health\b|\b(?:analyse|analyze|review)\s+(?:my\s+|our\s+)?(?:calendar|schedule|meetings?)\b|\b(?:ideal|best)\s+times?\s+(?:of\s+(?:the\s+)?day|to\s+(?:focus|work))\b|\bwhen\s+should\s+i\s+(?:do\s+)?(?:focus|deep)\s+work\b|\bhow\s+much\s+(?:focus|deep)\s+time\b|\bwhere\s+is\s+my\s+(?:time|week)\s+going\b/i;

const AHEAD_RE = /\b(next|coming|upcoming|ahead|this\s+week)\b/i;

function matchIntent(message: string): Params | null {
  const m = message.trim();
  if (!INTENT_RE.test(m)) return null;
  /* "last quarter" / "past 30 days" moves the window; the default
     stays two weeks when nobody said. */
  const explicit = /\b(\d{1,2})\s*(?:days?|weeks?)\b/i.exec(m);
  let days = 14;
  if (explicit) {
    const n = Number(explicit[1]);
    days = /week/i.test(explicit[0]) ? n * 7 : n;
  } else if (/\bquarter\b/i.test(m)) {
    days = 90;
  } else if (/\bmonth\b/i.test(m)) {
    days = 30;
  }
  return {
    days: Math.min(90, Math.max(7, days)),
    direction: AHEAD_RE.test(m) ? "ahead" : "past",
  };
}

export const scheduleHealthTool: ToolDef<Params, ScheduleHealthData> = {
  name: "schedule_health",
  description:
    "Analyse the shape of a person's calendar: how much unbooked time is actually usable, where the back-to-back runs are, what the standing meetings cost, and which hours are worth defending. Rule-based; no AI tokens.",
  paramSchema: ParamSchema,
  capability: "calendar.read",
  matchIntent,
  async handler(params, ctx): Promise<ToolResult<ScheduleHealthData>> {
    const { listEvents } = await import("@/lib/integrations/microsoft-calendar");

    const now = new Date();
    const span = params.days * 24 * 60 * 60 * 1000;
    const from = params.direction === "past" ? new Date(now.getTime() - span) : now;
    const to = params.direction === "past" ? now : new Date(now.getTime() + span);

    const raw = await listEvents(ctx.userId, {
      from: from.toISOString(),
      to: to.toISOString(),
      /* Enough for the window rather than a flat 200. A quarter of a busy
         calendar runs to thousands of events, and asking for 200 of them
         used to return the first 200 and report their totals as the whole
         quarter. Twelve a day is generous and still bounded. */
      limit: Math.min(5_000, params.days * 12),
    });

    const events: ScheduleEvent[] = (raw ?? [])
      .map((e) => {
        /* Two shapes of calendar event exist in the codebase: Graph's
           start/end and the briefing's startTime/endTime. Read both, so
           this analysis is not tied to which one the caller happened to
           have. */
        const r = e as unknown as Record<string, unknown>;
        return {
          subject: String(r.subject ?? "(no subject)"),
          start: String(r.start ?? r.startTime ?? ""),
          end: String(r.end ?? r.endTime ?? ""),
          attendees: Array.isArray(r.attendees)
            ? (r.attendees as unknown[]).map((a) =>
                typeof a === "string" ? a : String((a as { name?: string })?.name ?? "attendee"),
              )
            : undefined,
          /* What decides whether an entry is a meeting at all. */
          showAs: typeof r.showAs === "string" ? r.showAs : null,
          isCancelled: r.isCancelled === true,
          isAllDay: r.isAllDay === true,
          responseStatus: typeof r.responseStatus === "string" ? r.responseStatus : null,
        };
      })
      .filter((e) => e.start && e.end);

    /* The person's own zone, from their mailbox settings. Without it
       every hour in the report is the server's, which on Vercel means
       UTC: a Detroit dealer would be told to defend somebody else's
       afternoon. Best-effort, because a report in UTC that SAYS it is
       in UTC is still honest, and refusing to answer because a settings
       call failed would not be. */
    let timeZone: string | null = null;
    try {
      const { getOwnMailboxSettings } = await import(
        "@/lib/integrations/microsoft-mailbox"
      );
      timeZone = (await getOwnMailboxSettings(ctx.userId))?.timeZone ?? null;
    } catch {
      timeZone = null;
    }

    const report = analyseSchedule(events, {
      days: params.days,
      hours: DEFAULT_HOURS,
      timeZone,
    });

    /* Shape only. What is IN somebody's calendar is among the most
       sensitive data we hold, and none of it is needed to learn whether
       this analysis is worth keeping. */
    trackEvent("assistant.schedule_analysed", ctx.userId, ctx.userRole, {
      days: params.days,
      direction: params.direction,
      /* The zone is not personal data and it decides whether every
         other number here means anything. */
      time_zone: report.timeZone,
      meetings: report.meetings,
      usable_blocks: report.usableBlocks,
      stranded_hours: report.strandedHours,
      back_to_back_runs: report.backToBackRuns,
    });

    return {
      ok: true,
      data: {
        days: params.days,
        direction: params.direction,
        meetings: report.meetings,
        usableBlocks: report.usableBlocks,
        strandedHours: report.strandedHours,
      },
      answer: renderSchedule(report),
    };
  },
};

registerTool(scheduleHealthTool);
