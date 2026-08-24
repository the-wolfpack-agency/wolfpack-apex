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

/**
 * TELLING SOMEBODY SOMETHING RARELY USES THE WORD "MESSAGE".
 *
 * This required the literal noun. Swept on 2026-08-24: all five ordinary
 * phrasings missed. "tell the team it is ready for review", "let the
 * dealer know the part arrived", "send a note to Dana about the delay",
 * "post to the channel", "message the team that the car is ready".
 *
 * Every one reached a model, which cannot send anything, so the person
 * got a paragraph about how they might word it instead of a draft with a
 * send button and a confirmation step.
 *
 * THE DISCRIMINATOR IS WHO IS BEING TOLD. "tell the team" is a message.
 * "tell me about the Ackerman account" is a question, and a matcher that
 * took both would answer somebody's question with a compose form. So the
 * recipient may not be the person asking: me, myself and us-as-speaker
 * are excluded, and a third party is required.
 */
const RECIPIENT = "(?!me\\b|us\\b|myself\\b|ourselves\\b)(?:the\\s+)?[a-z][a-z0-9'’.\\- ]{1,40}?";

const INTENT_RE = new RegExp(
  [
    `\\b(?:create|compose|draft|send|new|write)\\s+(?:a\\s+)?(?:teams\\s+)?(?:chat\\s+)?message\\b(?!\\s+(?:from|about|labeled))`,
    /* tell <someone> that|it|the ... */
    `\\btell\\s+${RECIPIENT}\\s+(?:that|it|the|about\\s+the)\\b`,
    /* let <someone> know ... */
    `\\blet\\s+${RECIPIENT}\\s+know\\b`,
    /* send <someone> a note / send a note to <someone> */
    `\\bsend\\s+(?:a\\s+)?(?:note|word|update)\\s+to\\s+${RECIPIENT}`,
    `\\bsend\\s+${RECIPIENT}\\s+(?:a\\s+)?(?:note|word|update|message)\\b`,
    /* post to the channel / message the team */
    `\\bpost\\s+(?:to|in)\\s+(?:the\\s+)?(?:channel|team|group|thread)\\b`,
    `\\bmessage\\s+(?:the\\s+)?(?:team|group|channel|dealer|client)\\b`,
  ].join("|"),
  "i",
);

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
