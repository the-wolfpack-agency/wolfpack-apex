/**
 * meeting_prep — cross-source synthesis tool.
 *
 * Trigger phrases (all standalone, anchored):
 *   "prep for my next meeting"
 *   "brief me for my next meeting"
 *   "meeting prep"
 *   "what should i know about my next meeting"
 *
 * Distinct from the existing prebrief composition path (/api/meetings/
 * prebrief/[id]) which renders raw composed data: this tool returns a
 * SYNTHESIZED MeetingPrep widget. The synthesis path makes exactly one
 * Haiku call per (workspace, meeting, source_hash) — re-asks from any
 * teammate hit the same cache.
 *
 * Resolution: when the user doesn't name an event, we look up the next
 * calendar event in the next 8 hours and use that. If nothing's
 * upcoming, return an empty-state answer (no LLM call).
 */

import { z } from "zod";
import { fetchCalendarEvents, type CalendarEvent } from "@/lib/microsoft-graph";
import { trackEvent } from "@/lib/analytics";
import { prepareMeeting } from "@/lib/insights/meeting-prep";
import { registerTool } from "./registry";
import type { ToolDef, ToolResult } from "./types";
import type {
  MeetingPrepWidgetSpec,
  MeetingPrepWidgetSourceRef,
} from "@/lib/assistant/widgets/types";

/* --------------------------- Params ----------------------------------- */

const ParamSchema = z.object({
  /** Optional natural-language hint about which meeting ("for my meeting
   *  with Acme"). When unset, the handler picks the next event. */
  eventHint: z.string().optional(),
  /** Internal — set by the dispatcher when the user explicitly asked to
   *  regenerate. Today only the widget surfaces this through the API
   *  route; the chat-tool path leaves this false. */
  force: z.boolean().optional(),
});
type Params = z.infer<typeof ParamSchema>;

interface MeetingPrepToolData {
  kind: "meeting_prep";
  meetingId: string | null;
  cacheStatus: "hit" | "miss" | "regenerated" | "none";
}

/* --------------------------- Intent ----------------------------------- */

/* Three disjoint patterns — anchored ^/$ on the literal verbs/nouns so
 * the dispatcher doesn't shadow the existing /api/meetings/prebrief
 * lookup phrasing ("show me the prebrief for meeting X"). The optional
 * "<event title>" capture after "for" is a hint the handler uses when
 * resolving; today it's not load-bearing for the test cases (resolution
 * still goes to "next event in the next 8h") but the regex is shaped so
 * a future enhancement can use it. */
const INTENT_PATTERNS = [
  /^\s*(?:prep|brief)(?:\s+me)?(?:\s+for)?(?:\s+my)?(?:\s+(?:next|upcoming))?\s+(?:meeting|call|sync)(?:\s+(?:with\s+)?(.+))?[\s.?!]*$/i,
  /^\s*meeting\s+prep[\s.?!]*$/i,
  /^\s*what\s+should\s+i\s+know\s+(?:about|for)\s+my\s+(?:next\s+|upcoming\s+)?(?:meeting|call)\??[\s.?!]*$/i,
  /* Found by sweeping the phrasings on 2026-08-24: four of five ordinary
     ways of asking to be got ready for a meeting reached a model instead
     of the tool built for it. "Prep" is our word; brief me, get me ready
     and what do I need to know are theirs.
     A TIME rather than the word "meeting" is the commonest of all: "brief
     me on my 10am" names the thing by when it is. */
  /^\s*(?:brief|prep|prepare|catch)\s+me\s+(?:up\s+)?(?:on|for)\s+(?:my\s+)?(?:next\s+)?(?:\d{1,2}(?::\d{2})?\s*(?:am|pm)?|meeting|call|sync|one\s*[- ]?on\s*[- ]?one|1:1)\b/i,
  /^\s*get\s+me\s+ready\s+for\s+(?:my\s+|the\s+)?(?:next\s+)?(?:meeting|call|sync|\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b/i,
  /^\s*what\s+do\s+i\s+need\s+to\s+know\s+(?:before|for|about)\s+(?:this|my|the)\s+(?:next\s+)?(?:meeting|call|sync)\b/i,
  /^\s*who\s+am\s+i\s+meeting\b/i,
];

function matchMeetingPrepIntent(message: string): Params | null {
  const trimmed = message.trim();
  for (const re of INTENT_PATTERNS) {
    const m = re.exec(trimmed);
    if (m) {
      const hint = m[1]?.trim();
      return { eventHint: hint && hint.length > 0 ? hint : undefined };
    }
  }
  return null;
}

/* ----------------------- Event resolution ----------------------------- */

async function resolveNextMeeting(
  userId: string,
  hint?: string,
): Promise<CalendarEvent | null> {
  const now = Date.now();
  const hour = 60 * 60 * 1000;
  const start = new Date(now - 1 * hour).toISOString();
  const end = new Date(now + 8 * hour).toISOString();
  let events: CalendarEvent[] = [];
  try {
    events = await fetchCalendarEvents(userId, start, end);
  } catch {
    return null;
  }
  if (events.length === 0) return null;

  /* Sort by start ascending. */
  const upcoming = events
    .filter((e) => Date.parse(e.start) >= now - 5 * 60 * 1000)
    .sort((a, b) => (a.start < b.start ? -1 : 1));

  if (!hint) {
    return upcoming[0] ?? events[0];
  }
  const lowerHint = hint.toLowerCase();
  const matched = upcoming.find((e) =>
    [e.subject, ...(e.attendees ?? []), ...(e.attendeeEmails ?? [])]
      .map((s) => (s ?? "").toLowerCase())
      .some((s) => s.includes(lowerHint)),
  );
  return matched ?? upcoming[0] ?? events[0];
}

/* --------------------------- Widget shape ----------------------------- */

const REGEN_ROLES = new Set(["cto", "ceo", "evp", "ops", "hr"]);

function buildEmptySpec(args: {
  meetingId: string;
  subject: string;
  start: string;
  cacheStatus: "hit" | "miss" | "regenerated";
  generatedAt: string;
  viewerCanRegenerate: boolean;
}): MeetingPrepWidgetSpec {
  return {
    kind: "meeting_prep",
    meetingId: args.meetingId,
    subject: args.subject,
    start: args.start,
    cacheStatus: args.cacheStatus,
    generatedAt: args.generatedAt,
    synthesisUnavailable: true,
    summary: "",
    goal: "",
    talking_points: [],
    risk_flags: [],
    attendee_briefs: [],
    open_questions: [],
    viewerCanRegenerate: args.viewerCanRegenerate,
  };
}

function toRefArray(
  v: ReadonlyArray<{
    type: string;
    id: string;
    label: string;
    url?: string;
  }> | undefined,
): MeetingPrepWidgetSourceRef[] {
  if (!v) return [];
  return v.map((r) => ({ type: r.type, id: r.id, label: r.label, url: r.url }));
}

/* --------------------------- Tool def --------------------------------- */

export const meetingPrepTool: ToolDef<Params, MeetingPrepToolData> = {
  name: "meeting_prep",
  description:
    "Synthesize a cross-source pre-brief for the user's next meeting (calendar + email + CRM + brain). Returns a structured widget. Shared cache per workspace + meeting + source-hash — same meeting = same insight for every teammate.",
  paramSchema: ParamSchema,
  capability: "meetings.view",
  matchIntent: matchMeetingPrepIntent,
  async handler(params, ctx): Promise<ToolResult<MeetingPrepToolData>> {
    const event = await resolveNextMeeting(ctx.userId, params.eventHint);
    if (!event) {
      return {
        ok: true,
        data: { kind: "meeting_prep", meetingId: null, cacheStatus: "none" },
        answer:
          "I don't see a meeting in the next 8 hours. Try asking again closer to your next event, or name a specific meeting.",
      };
    }

    const workspaceId = ctx.workspaceId || "default";
    const viewerCanRegenerate = REGEN_ROLES.has((ctx.userRole || "").toLowerCase());

    const result = await prepareMeeting(event.id, {
      workspaceId,
      userId: ctx.userId,
      userRole: ctx.userRole,
      force: params.force === true,
    });

    /* Fan-out returned null only when the event isn't in the calendar
     * window we fetched. Surface a friendly answer instead of an error. */
    if (!result) {
      return {
        ok: true,
        data: { kind: "meeting_prep", meetingId: event.id, cacheStatus: "none" },
        answer: `I couldn't pull pre-brief data for "${event.subject}" — the event isn't in the calendar window I can read. Try again after the calendar sync completes.`,
      };
    }

    void trackEvent("assistant.widget_offered", ctx.userId, ctx.userRole, {
      widget_kind: "meeting_prep",
      meeting_id: event.id,
      cache_status: result.cacheStatus,
    });

    if (result.synthesisUnavailable || !result.prep) {
      const widget = buildEmptySpec({
        meetingId: event.id,
        subject: event.subject,
        start: event.start,
        cacheStatus: result.cacheStatus,
        generatedAt: result.generatedAt,
        viewerCanRegenerate,
      });
      return {
        ok: true,
        data: {
          kind: "meeting_prep",
          meetingId: event.id,
          cacheStatus: result.cacheStatus,
        },
        answer: `I pulled the source data for "${event.subject}" but couldn't synthesize a clean summary just now. The raw attendees + recent email signal is below.`,
        widget,
      };
    }

    const prep = result.prep;
    const spec: MeetingPrepWidgetSpec = {
      kind: "meeting_prep",
      meetingId: event.id,
      subject: event.subject,
      start: event.start,
      cacheStatus: result.cacheStatus,
      generatedAt: result.generatedAt,
      synthesisUnavailable: false,
      summary: prep.summary,
      goal: prep.goal,
      talking_points: prep.talking_points.map((tp) => ({
        point: tp.point,
        source_refs: toRefArray(tp.source_refs),
      })),
      risk_flags: prep.risk_flags.map((rf) => ({
        flag: rf.flag,
        severity: rf.severity,
        source_refs: toRefArray(rf.source_refs),
      })),
      attendee_briefs: prep.attendee_briefs.map((ab) => ({
        email: ab.email,
        name: ab.name,
        one_liner: ab.one_liner,
        key_facts: ab.key_facts,
        links: toRefArray(ab.links),
      })),
      open_questions: prep.open_questions,
      viewerCanRegenerate,
    };

    const cachePill =
      result.cacheStatus === "hit"
        ? "shared with your team"
        : result.cacheStatus === "regenerated"
          ? "freshly regenerated"
          : "freshly generated";
    const answer = `Here's your pre-brief for "${event.subject}" — ${cachePill}.`;

    return {
      ok: true,
      data: {
        kind: "meeting_prep",
        meetingId: event.id,
        cacheStatus: result.cacheStatus,
      },
      answer,
      widget: spec,
    };
  },
};

registerTool(meetingPrepTool);
