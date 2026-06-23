/**
 * feedback — the slash-command tool the team-onboarding session uses
 * to capture honest reactions inline in the chat.
 *
 * Intent rules (the tool NEVER silently writes on ambiguous natural
 * language, only an explicit command form records immediately):
 *
 *   IMMEDIATE WRITE (mode: recorded), explicit command form only:
 *     /feedback <message>                      → leading slash + body, recorded immediately
 *     feedback: <message>                      → explicit colon separator, recorded immediately
 *     i have feedback: <message>               → explicit colon separator, recorded immediately
 *     share feedback: <message>                → explicit colon separator, recorded immediately
 *
 *   COMPOSE (mode: compose), opens the textarea widget, NO db write:
 *     /feedback                                → bare slash; nothing to record yet
 *     feedback                                 → bare verb stem
 *     i have feedback                          → bare verb stem
 *     share feedback                           → bare verb stem
 *     share feedback about Instinct            → body, but NO slash and NO colon
 *     feedback about the calendar              → body, but NO slash and NO colon
 *
 *   NOT A FEEDBACK INTENT (return null):
 *     find emails about feedback / feedbacks are great / etc., the
 *     verb stem must lead the message, otherwise this is just a noun.
 *
 * The natural-language-with-a-body case (no slash, no colon) is the
 * source of the recurring "/admin/feedback duplicates with fresh
 * timestamps" bug: a starter chip "share feedback about Instinct" was
 * being parsed as feedback-tool + body="about Instinct" and writing a
 * row on every click. We now route that to COMPOSE so the user
 * confirms before anything is persisted.
 *
 * Handler behaviour:
 *   - Message present and non-empty → call recordUserFeedback() and
 *     return the FeedbackWidgetSpec in `mode: "recorded"` state. The
 *     analytics event fires from inside the lib so every entry path
 *     stays consistent.
 *   - Message absent / blank → return the widget in `mode: "compose"`
 *     state. The widget renders a textarea and POSTs to /api/feedback
 *     when the user submits — same lib path, same analytics.
 *
 * Registered BEFORE `search` so the slash-command intent isn't
 * shadowed by the universal search cascade.
 */

import { z } from "zod";
import { trackEvent } from "@/lib/analytics";
import {
  recordUserFeedback,
  MAX_FEEDBACK_LENGTH,
} from "@/lib/feedback/record-feedback";
import { registerTool } from "./registry";
import type { ToolDef, ToolResult } from "./types";
import type { FeedbackWidgetSpec } from "@/lib/assistant/widgets/types";

const ParamSchema = z.object({
  message: z.string().max(MAX_FEEDBACK_LENGTH).default(""),
});
type Params = z.infer<typeof ParamSchema>;

interface FeedbackData {
  kind: "feedback";
  mode: "recorded" | "compose";
  feedback_id?: string;
}

/* Stem matcher. Group 1 = a leading slash (present or empty), group 2 =
 * the verb stem, group 3 = the separator-or-tail, group 4 = the body.
 * The verb stem must LEAD the message. The trailing `\b` keeps
 * "feedbacks" (plural noun in a different sentence) from claiming the
 * intent.
 *
 * After the stem we look at HOW the body is introduced to decide
 * recorded vs compose:
 *   - leading slash + body             → recorded (explicit command)
 *   - ":" colon separator + body       → recorded (explicit separator)
 *   - whitespace-only + body, no slash → compose  (natural language)
 *   - nothing after the stem           → compose  (bare command)
 */
const INTENT_RE =
  /^\s*(\/?)(feedback|i\s+have\s+feedback|share\s+feedback)\b([:\s]*)(.*)$/i;

export function matchFeedbackIntent(message: string): Params | null {
  const trimmed = (message ?? "").trim();
  if (!trimmed) return null;
  const m = trimmed.match(INTENT_RE);
  if (!m) return null;

  const hadSlash = m[1] === "/";
  const separator = m[3] ?? "";
  const body = (m[4] ?? "").trim();

  /* Bare command (no body) → compose, regardless of slash/colon. */
  if (!body) return { message: "" };

  /* Body present. Only an EXPLICIT command form records immediately:
   * a leading slash, or a colon separator after the verb stem. Plain
   * natural language ("share feedback about Instinct") has neither and
   * must open the compose widget so the user confirms before we write.
   * This is the fix for the duplicate-rows bug. */
  const hadColon = separator.includes(":");
  if (!hadSlash && !hadColon) {
    return { message: "" };
  }

  if (body.length > MAX_FEEDBACK_LENGTH) {
    /* Refuse oversized free-text at intent time so the dispatcher can
     * fall through to the AI fallback with a polite error rather than
     * the tool returning ok:false after a partial write attempt. */
    return null;
  }
  return { message: body };
}

export const feedbackTool: ToolDef<Params, FeedbackData> = {
  name: "feedback",
  description:
    "Capture a free-form note from the user. Explicit command form '/feedback <message>' or 'feedback: <message>' writes immediately and confirms with a widget. Bare 'feedback' or natural language like 'share feedback about X' opens a compose widget with a textarea so the user confirms before anything is saved.",
  paramSchema: ParamSchema,
  capability: "assistant.use",
  matchIntent: matchFeedbackIntent,
  async handler(params, ctx): Promise<ToolResult<FeedbackData>> {
    const workspaceId = ctx.workspaceId || "default";
    const message = (params.message ?? "").trim();

    if (!message) {
      /* Compose path — render the widget with a textarea. No DB write
       * yet; the widget will POST to /api/feedback on submit. */
      trackEvent("assistant.widget_offered", ctx.userId, ctx.userRole, {
        widget_kind: "feedback",
        mode: "compose",
        ...(ctx.workflowId ? { workflow_id: ctx.workflowId } : {}),
      });
      const spec: FeedbackWidgetSpec = {
        kind: "feedback",
        mode: "compose",
        surface: "/assistant",
        submitUrl: "/api/feedback",
      };
      return {
        ok: true,
        data: { kind: "feedback", mode: "compose" },
        answer:
          "Happy to capture that. Drop a note in the box below and I'll save it for the team.",
        sources: [],
        widget: spec,
      };
    }

    /* Recorded path — write the row, then return a confirmation widget. */
    try {
      const out = await recordUserFeedback({
        workspaceId,
        userId: ctx.userId,
        userEmail: ctx.userEmail,
        userRole: ctx.userRole,
        message,
        surface: "/assistant",
        workflowId: ctx.workflowId,
      });

      trackEvent("assistant.widget_offered", ctx.userId, ctx.userRole, {
        widget_kind: "feedback",
        mode: "recorded",
        ...(ctx.workflowId ? { workflow_id: ctx.workflowId } : {}),
      });

      const spec: FeedbackWidgetSpec = {
        kind: "feedback",
        mode: "recorded",
        feedbackId: out.id,
        message,
        surface: "/assistant",
        submitUrl: "/api/feedback",
      };

      const shortId = out.id.replace(/-/g, "").slice(0, 8);
      return {
        ok: true,
        data: { kind: "feedback", mode: "recorded", feedback_id: out.id },
        answer: `Thanks. Feedback recorded as #${shortId}.`,
        sources: [],
        widget: spec,
      };
    } catch (err) {
      /* recordUserFeedback re-throws WriteQueryError on a DB failure.
       * Surface as a typed tool failure so the dispatcher's
       * `assistant.tool_failed` event fires; the user sees a polite
       * "couldn't save that, please try again" instead of a 500. */
      return {
        ok: false,
        code: "internal",
        message: `Couldn't save your feedback: ${(err as Error).message}`,
      };
    }
  },
};

registerTool(feedbackTool);
