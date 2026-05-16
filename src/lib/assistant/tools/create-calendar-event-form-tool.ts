/**
 * create_calendar_event_form — surfaces a form for booking a calendar
 * event. Trigger phrases: "create calendar event", "create event",
 * "schedule a meeting", "book a meeting", "new calendar event".
 *
 * The Phase-3 confirmation-pending-action tool covers "log a call
 * with Jorge about pricing" → CRM Task creation. This is the calendar
 * counterpart for MS Graph events.
 */

import { z } from "zod";
import { trackEvent } from "@/lib/analytics";
import { registerTool } from "./registry";
import type { ToolDef, ToolResult } from "./types";
import { calendarEventFormSpec } from "@/lib/assistant/forms/specs";

const ParamSchema = z.object({
  title: z.string().min(1).max(200).optional(),
});
type Params = z.infer<typeof ParamSchema>;

interface CreateCalendarEventFormData {
  formKind: "create_calendar_event";
}

const INTENT_RE =
  /\b(?:create|new|schedule|book|add|set\s+up)\s+(?:an?\s+)?(?:calendar\s+)?(?:event|meeting|appointment|call)\b/i;
const TITLE_RE = /\b(?:titled|called|named|about|for)\s+["']?([^"'\n]{2,80})["']?/i;

function matchCalendarEventFormIntent(message: string): Params | null {
  if (!INTENT_RE.test(message)) return null;
  const params: Params = {};
  const t = TITLE_RE.exec(message);
  if (t) params.title = t[1].trim();
  return params;
}

export const createCalendarEventFormTool: ToolDef<Params, CreateCalendarEventFormData> = {
  name: "create_calendar_event_form",
  description:
    "Surface a form in the chat for booking a calendar event. Title, start, and end are required.",
  paramSchema: ParamSchema,
  capability: "*",
  matchIntent: matchCalendarEventFormIntent,
  async handler(params, ctx): Promise<ToolResult<CreateCalendarEventFormData>> {
    trackEvent("assistant.form_offered", ctx.userId, ctx.userRole, {
      form_kind: "create_calendar_event",
      prefilled_title: params.title ? true : false,
    });
    return {
      ok: true,
      data: { formKind: "create_calendar_event" },
      answer: "Fill in the event below.",
      form: calendarEventFormSpec({
        title: params.title,
      }),
    };
  },
};

registerTool(createCalendarEventFormTool);
