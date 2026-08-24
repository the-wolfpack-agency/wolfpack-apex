/**
 * create_feature_form — surfaces a form for filing a product feature
 * request. Trigger phrases: "create feature", "new feature request",
 * "add a feature", "request a feature".
 *
 * Posts to /api/features which writes to instinct_feature_requests.
 * Available to every authenticated role — anyone can request a feature;
 * triage is a separate workflow.
 */

import { z } from "zod";
import { trackEvent } from "@/lib/analytics";
import { registerTool } from "./registry";
import type { ToolDef, ToolResult } from "./types";
import { featureFormSpec } from "@/lib/assistant/forms/specs";

const ParamSchema = z.object({
  title: z.string().min(1).max(200).optional(),
});
type Params = z.infer<typeof ParamSchema>;

interface CreateFeatureFormData {
  formKind: "create_feature";
}

/**
 * "Log a feature request" did not match a feature-request tool.
 *
 * The verbs were create, new, add, request, file and submit. Swept
 * 2026-08-24: all five natural phrasings missed, including "log a feature
 * request" and "raise a feature request", which are the two verbs most
 * people reach for.
 *
 * The most valuable phrasing has no verb of ours in it at all. "the
 * client wants a new report" is how a request actually arrives: somebody
 * repeating what they were just told. That is the sentence this product
 * exists to catch, because otherwise it stays in a mailbox.
 */
const INTENT_RE = new RegExp(
  [
    `\\b(?:create|new|add|request|file|submit|log|raise|capture|open)\\s+(?:an?\\s+)?(?:feature(?:\\s+request)?|product\\s+request|roadmap\\s+item)\\b`,
    `\\b(?:add|put)\\s+(?:a\\s+)?(?:request|feature)\\s+(?:to|on)\\s+the\\s+backlog\\b`,
    `\\bcapture\\s+(?:this|that|it)\\s+as\\s+a\\s+feature\\b`,
    /* How a request actually arrives. */
    `\\b(?:the\\s+)?(?:client|customer|dealer|they)\\s+(?:wants?|asked\\s+for|needs?|would\\s+like)\\s+(?:a|an|the)\\s+\\w`,
  ].join("|"),
  "i",
);
const TITLE_RE = /\b(?:titled|called|named|for|about)\s+["']?([^"'\n]{2,160})["']?/i;

function matchFeatureFormIntent(message: string): Params | null {
  if (!INTENT_RE.test(message)) return null;
  const params: Params = {};
  const t = TITLE_RE.exec(message);
  if (t) params.title = t[1].trim();
  return params;
}

export const createFeatureFormTool: ToolDef<Params, CreateFeatureFormData> = {
  name: "create_feature_form",
  description:
    "Surface a form in the chat for filing a product feature request. Title + description are required.",
  paramSchema: ParamSchema,
  capability: "*",
  matchIntent: matchFeatureFormIntent,
  async handler(params, ctx): Promise<ToolResult<CreateFeatureFormData>> {
    trackEvent("assistant.form_offered", ctx.userId, ctx.userRole, {
      form_kind: "create_feature",
      prefilled_title: params.title ? true : false,
    });
    return {
      ok: true,
      data: { formKind: "create_feature" },
      answer: "Describe the feature below.",
      form: featureFormSpec({ title: params.title }),
    };
  },
};

registerTool(createFeatureFormTool);
