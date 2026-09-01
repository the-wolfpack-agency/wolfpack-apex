/**
 * pilot_status: "how is the pilot going", answered from three systems at once.
 *
 * THE GAP THIS FILLS. A routing audit on 2026-08-26 scored every ordinary
 * sentence a person types at this product. The `status` cluster came back
 * WHOLLY dead: "what's blocking the pilot", "how is the pilot going" and
 * "what's left to do" reached no tool at all. That was not a phrasing gap that
 * a wider regex fixes. No tool existed. It is also the first question a client
 * asks, and it was the one question sixty tools could not answer.
 *
 * WHY IT IS A JOIN AND NOT A LIST. Any single connected tool can show you its
 * own contents. The calendar knows there is a review on Thursday. The task
 * store knows three things are overdue. Neither knows that the three overdue
 * things are due before the review, and that sentence is the entire product.
 * The cross-source signals are emitted first for that reason; the
 * single-source ones are context around them.
 *
 * WHY IT IS FULL OF THE WORD "UNKNOWN". Status is where a zero is most likely
 * to be read as good news, and this codebase has just been through six
 * controls that were declared, described accurately and never executed, each
 * reporting a zero somebody took for a clean bill of health. So a source that
 * could not be read is never counted as empty, the verdict refuses to be
 * optimiztic with fewer than two readable sources, and the partial view says
 * so in the first line of the spoken answer rather than in the widget.
 *
 * Zero AI tokens. Three reads and a rule set.
 */

import { z } from "zod";
import { trackEvent } from "@/lib/analytics";
import { readPilotStatus, DEFAULT_WINDOW_DAYS } from "@/lib/pilot/status";
import {
  buildSignals,
  completedTaskCount,
  darkSources,
  documentsLanded,
  formatWhen,
  nextMeeting,
  openTaskCount,
  overdueTaskCount,
  readableSources,
  readiness,
  readinessLabel,
  SOURCE_LABEL,
  summarize,
} from "@/lib/pilot/status-shape";
import type { PilotStatusSourceLine, PilotStatusWidgetSpec } from "@/lib/assistant/widgets/types";
import { registerTool } from "./registry";
import type { ToolDef, ToolResult } from "./types";

const ParamSchema = z.object({
  windowDays: z.number().int().min(1).max(90).default(DEFAULT_WINDOW_DAYS),
});
type Params = z.infer<typeof ParamSchema>;

interface PilotStatusData {
  kind: "pilot_status";
  readiness: string;
  readableSourceCount: number;
  darkSourceCount: number;
  signalCount: number;
  crossSourceSignalCount: number;
}

/**
 * The words people use for "how is it going".
 *
 * Three families, and none of them contains the word "status" reliably:
 *
 *   PROGRESS   how is the pilot going, where are we, how are we tracking
 *   BLOCKERS   what's blocking the pilot, what's in the way, what's at risk
 *   REMAINING  what's left to do, what's outstanding on the pilot, what's next
 *
 * The subject is deliberately open ("the pilot", "the project", "the
 * engagement", "the rollout", "things", or nothing at all) because a client
 * says "how are we doing" and an operator says "how's the Porsche pilot", and
 * both mean this.
 *
 * BOUNDED ON PURPOSE. "what's left to do" is close to the task list's "what
 * have I got outstanding", and the two tools would fight over it. The
 * difference is scope: a bare "anything overdue" is a personal to-do question
 * and belongs to task_list_widget, while "what's left on the pilot" is a
 * question about an engagement. So the REMAINING family requires either an
 * engagement noun or the "left to do" framing, and the negative cases are
 * pinned in the tests so a later widening cannot quietly steal them.
 */
const SUBJECT = "(?:the\\s+|this\\s+|our\\s+|my\\s+)?(?:pilot|project|engagement|rollout|program|program|phase\\s*(?:one|1|two|2)|poc|trial|onboarding)";

const INTENT_RE = new RegExp(
  [
    /* PROGRESS. "how is the pilot going", "how's the project tracking". */
    `\\bhow(?:'?s|\\s+is|\\s+are)\\s+(?:${SUBJECT}|we|things|it)\\s+(?:going|tracking|doing|progressing|coming\\s+along|looking)\\b`,
    `\\bhow(?:\\s+are)?\\s+we\\s+doing\\s+on\\s+${SUBJECT}\\b`,
    /* "where are we on the pilot", "where do we stand". */
    `\\bwhere\\s+(?:are\\s+we|do\\s+we\\s+stand)(?:\\s+(?:on|with)\\s+${SUBJECT})?\\b`,
    /* Explicit status nouns, with a subject so "status" alone stays free. */
    `\\b(?:${SUBJECT})\\s+status\\b`,
    `\\bstatus\\s+of\\s+${SUBJECT}\\b`,
    `\\b(?:give\\s+me\\s+|show\\s+me\\s+)?(?:a\\s+)?(?:status\\s+)?update\\s+on\\s+${SUBJECT}\\b`,

    /* BLOCKERS. */
    `\\bwhat(?:'?s|\\s+is)\\s+blocking\\s+(?:${SUBJECT}|us|me|things)?\\b`,
    `\\bwhat(?:'?s|\\s+is|\\s+are)\\s+(?:the\\s+)?blockers?\\b`,
    `\\bwhat(?:'?s|\\s+is)\\s+in\\s+(?:the|our|my)\\s+way\\b`,
    `\\bwhat(?:'?s|\\s+is)\\s+at\\s+risk\\b`,
    `\\bwhat(?:'?s|\\s+is)\\s+holding\\s+(?:us|it|things)\\s+up\\b`,
    `\\bare\\s+we\\s+(?:on\\s+track|behind|at\\s+risk)\\b`,

    /* REMAINING. Scoped so the personal to-do list keeps its own questions. */
    `\\bwhat(?:'?s|\\s+is)\\s+left\\s+to\\s+do\\b`,
    `\\bwhat(?:'?s|\\s+is)\\s+(?:still\\s+)?(?:left|remaining|outstanding)\\s+(?:on|for|in)\\s+${SUBJECT}\\b`,
    `\\bwhat(?:'?s|\\s+is)\\s+(?:still\\s+)?left\\s+(?:on|for)\\s+${SUBJECT}\\b`,
  ].join("|"),
  "i",
);

export function matchPilotStatusIntent(message: string): Params | null {
  if (!INTENT_RE.test(message.trim())) return null;
  return { windowDays: DEFAULT_WINDOW_DAYS };
}

/** One row per source, dark ones included, counts null when unreadable. */
function sourceLines(
  r: Awaited<ReturnType<typeof readPilotStatus>>,
): PilotStatusSourceLine[] {
  const open = openTaskCount(r);
  const done = completedTaskCount(r);
  const landed = documentsLanded(r);
  return [
    {
      source: "calendar",
      state: r.calendar.state,
      count: r.calendar.state === "ok" ? r.calendar.items.length : null,
      detail:
        r.calendar.state === "ok"
          ? `${r.calendar.items.length} meeting${r.calendar.items.length === 1 ? "" : "s"} in the next ${r.windowDays} days`
          : (r.calendar.detail ?? "Not readable."),
    },
    {
      source: "documents",
      state: r.documents.state,
      count: landed,
      detail:
        landed !== null
          ? `${landed} landed in the Brain in the last ${r.windowDays} days`
          : (r.documents.detail ?? "Not readable."),
    },
    {
      source: "tasks",
      state: r.tasks.state,
      count: open,
      detail:
        open !== null
          ? `${open} open${done ? `, ${done} closed in the last ${r.windowDays} days` : ""}`
          : (r.tasks.detail ?? "Not readable."),
    },
  ];
}

export const pilotStatusTool: ToolDef<Params, PilotStatusData> = {
  name: "pilot_status",
  description:
    "Answer how an engagement is going by joining the calendar, the documents in the Brain and the task store into one view: what is blocking it, what is left to do, and which of those three systems could not be read. Zero AI tokens.",
  paramSchema: ParamSchema,
  capability: "*",
  matchIntent: matchPilotStatusIntent,
  async handler(params, ctx): Promise<ToolResult<PilotStatusData>> {
    const started = Date.now();
    const reading = await readPilotStatus({
      userId: ctx.onBehalfOfUserId ?? ctx.userId,
      userRole: ctx.userRole,
      windowDays: params.windowDays,
    });

    const signals = buildSignals(reading, ctx.timeZone);
    const verdict = readiness(reading);
    const readable = readableSources(reading);
    const dark = darkSources(reading);
    const next = nextMeeting(reading);
    const crossSource = signals.filter((s) => s.sources.length >= 2).length;

    const spec: PilotStatusWidgetSpec = {
      kind: "pilot_status",
      title: readinessLabel(verdict),
      subtitle:
        dark.length === 0
          ? `Joined from calendar, Brain and tasks over the last ${reading.windowDays} days.`
          : `Joined from ${readable.length} of 3 systems over the last ${reading.windowDays} days. ${dark.map((d) => SOURCE_LABEL[d.source]).join(" and ")} unavailable, so counts from ${dark.length === 1 ? "it are" : "them are"} unknown rather than zero.`,
      readiness: verdict,
      readinessLabel: readinessLabel(verdict),
      windowDays: reading.windowDays,
      takenAt: reading.takenAt,
      sources: sourceLines(reading),
      signals,
      nextCheckpoint: next
        ? { subject: next.subject, when: formatWhen(next.start, ctx.timeZone) }
        : null,
    };

    /* The learning loop needs to see WHICH sources were dark, not just that
       the tool ran. A rising dark-source rate is the early signal that this
       answer is quietly degrading into one list with a confident headline. */
    trackEvent("assistant.widget_offered", ctx.userId, ctx.userRole, {
      widget_kind: "pilot_status",
      readiness: verdict,
      readable_sources: readable.join(",") || "none",
      dark_sources: dark.map((d) => d.source).join(",") || "none",
      dark_source_count: dark.length,
      signal_count: signals.length,
      cross_source_signal_count: crossSource,
      /* "unknown", never 0, for a source that did not answer. An analytics
         series that reports a dark task store as zero open tasks is the same
         lie as the widget doing it, and it is the one that survives into a
         dashboard nobody re-derives. */
      open_tasks: openTaskCount(reading) ?? "unknown",
      overdue_tasks: overdueTaskCount(reading) ?? "unknown",
      documents_landed: documentsLanded(reading) ?? "unknown",
      window_days: reading.windowDays,
      duration_ms: Date.now() - started,
    });

    return {
      ok: true,
      data: {
        kind: "pilot_status",
        readiness: verdict,
        readableSourceCount: readable.length,
        darkSourceCount: dark.length,
        signalCount: signals.length,
        crossSourceSignalCount: crossSource,
      },
      answer: summarize(reading, ctx.timeZone),
      widget: spec,
    };
  },
};

registerTool(pilotStatusTool);
