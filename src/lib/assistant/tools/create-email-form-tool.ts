/**
 * create_email_form — surfaces an inline form for composing an email.
 *
 * Triggered by phrases like "create email", "create an email", "send
 * an email", "compose email", "draft an email". Optional pre-fill: if
 * the user said "create email to alice@..." or "send email about Q3",
 * we pre-populate the matching fields.
 *
 * The tool itself does NOT send the email — it returns a FormSpec the
 * chat UI renders. The form's submit POSTs to /api/assistant/forms/submit
 * which dispatches to /api/mail/send.
 */

import { z } from "zod";
import { trackEvent } from "@/lib/analytics";
import { registerTool } from "./registry";
import type { ToolDef, ToolResult } from "./types";
import { emailFormSpec } from "@/lib/assistant/forms/specs";

const ParamSchema = z.object({
  to: z.string().email().optional(),
  subject: z.string().min(1).max(200).optional(),
});
type Params = z.infer<typeof ParamSchema>;

interface CreateEmailFormData {
  formKind: "create_email";
}

const INTENT_RE =
  /\b(?:create|compose|draft|send|new|write)\s+(?:an?\s+)?(?:e[\s-]?mail|email)\b/i;
const TO_RE = /\b(?:to|email)\s+([\w.+-]+@[\w-]+\.[\w.-]+)/i;
const SUBJECT_RE = /\b(?:about|regarding|subject(?:\s*:)?)\s+([^.\n]{2,80})/i;

function matchEmailFormIntent(message: string): Params | null {
  if (!INTENT_RE.test(message)) return null;
  const params: Params = {};
  const toMatch = TO_RE.exec(message);
  if (toMatch) params.to = toMatch[1];
  const subjMatch = SUBJECT_RE.exec(message);
  if (subjMatch) params.subject = subjMatch[1].trim();
  return params;
}

export const createEmailFormTool: ToolDef<Params, CreateEmailFormData> = {
  name: "create_email_form",
  description:
    "Surface a form in the chat for composing an email. To/subject/body are required before send.",
  paramSchema: ParamSchema,
  capability: "*",
  matchIntent: matchEmailFormIntent,
  async handler(params, ctx): Promise<ToolResult<CreateEmailFormData>> {
    trackEvent("assistant.form_offered", ctx.userId, ctx.userRole, {
      form_kind: "create_email",
      prefilled_to: params.to ? true : false,
      prefilled_subject: params.subject ? true : false,
    });
    return {
      ok: true,
      data: { formKind: "create_email" },
      answer:
        "Fill in the email below. To, subject, and message are required — the Send button stays disabled until they're set.",
      form: emailFormSpec({
        to: params.to,
        subject: params.subject,
      }),
    };
  },
};

registerTool(createEmailFormTool);
