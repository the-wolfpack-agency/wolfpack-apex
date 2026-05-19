/**
 * feedback — the slash-command tool the team-onboarding session uses
 * to capture honest reactions inline in the chat.
 *
 * Trigger phrases (capture group 2 is the message; may be empty):
 *   /feedback                                  → bare; opens compose widget
 *   /feedback <message>                        → recorded immediately + thank-you widget
 *   feedback                                   → bare
 *   feedback: the calendar widget is broken    → "<colon><space>" optional separator
 *   i have feedback                            → bare
 *   i have feedback <message>                  → recorded immediately
 *   share feedback                             → bare
 *   share feedback <message>                   → recorded immediately
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

/* Capture group 2 is the message — may be empty when the user typed
 * a bare command. We deliberately allow either "feedback" or
 * "i have feedback" or "share feedback" as the verb stem; the colon
 * / space after the stem is optional so "feedback: hi" and
 * "feedback hi" both work. The `\b` after the stem keeps "feedbacks"
 * (plural noun in a different sentence) from claiming the intent. */
const INTENT_RE =
  /^\s*\/?(?:feedback|i\s+have\s+feedback|share\s+feedback)\b[:\s]*(.*)$/i;

export function matchFeedbackIntent(message: string): Params | null {
  const trimmed = (message ?? "").trim();
  if (!trimmed) return null;
  const m = trimmed.match(INTENT_RE);
  if (!m) return null;
  /* Group 1 is the captured tail (everything after the verb stem and
   * the optional ":" / whitespace separator). We then trim — bare
   * "/feedback" yields "". */
  const body = (m[1] ?? "").trim();
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
    "Capture a free-form note from the user. Slash command '/feedback <message>' (or 'i have feedback ...', 'share feedback ...') writes immediately and confirms with a widget. Bare '/feedback' opens a compose widget with a textarea.",
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
