/**
 * create_message_form — surfaces a form for sending a Teams chat
 * message from inside the Assistant. Trigger phrases: "create
 * message", "send a teams message", "draft a teams message", "send a
 * message in teams".
 *
 * Chat picker is currently a manual chat-id paste — autocomplete is
 * P2. We surface a helpText pointing to /messages so users can copy
 * the id from the URL.
 */

import { z } from "zod";
import { trackEvent } from "@/lib/analytics";
import { registerTool } from "./registry";
import type { ToolDef, ToolResult } from "./types";
import { messageFormSpec } from "@/lib/assistant/forms/specs";

const ParamSchema = z.object({
  chatId: z.string().min(1).max(200).optional(),
});
type Params = z.infer<typeof ParamSchema>;

interface CreateMessageFormData {
  formKind: "create_message";
}

const INTENT_RE =
  /\b(?:create|compose|draft|send|new|write)\s+(?:a\s+)?(?:teams\s+)?(?:chat\s+)?message\b(?!\s+(?:from|about|labeled))/i;

function matchMessageFormIntent(message: string): Params | null {
  if (!INTENT_RE.test(message)) return null;
  return {};
}

export const createMessageFormTool: ToolDef<Params, CreateMessageFormData> = {
  name: "create_message_form",
  description:
    "Surface a form in the chat for sending a Teams chat message. Chat id and body are required.",
  paramSchema: ParamSchema,
  capability: "*",
  matchIntent: matchMessageFormIntent,
  async handler(_params, ctx): Promise<ToolResult<CreateMessageFormData>> {
    trackEvent("assistant.form_offered", ctx.userId, ctx.userRole, {
      form_kind: "create_message",
    });
    return {
      ok: true,
      data: { formKind: "create_message" },
      answer: "Fill in the Teams message below.",
      form: messageFormSpec({}),
    };
  },
};

registerTool(createMessageFormTool);
