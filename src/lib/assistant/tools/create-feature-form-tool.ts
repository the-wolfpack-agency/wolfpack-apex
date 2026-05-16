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

const INTENT_RE =
  /\b(?:create|new|add|request|file|submit)\s+(?:an?\s+)?(?:feature(?:\s+request)?|product\s+request|roadmap\s+item)\b/i;
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
