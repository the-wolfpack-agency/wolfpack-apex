/**
 * create_okr_form — surfaces a form for creating a new OKR.
 *
 * Trigger phrases: "create OKR", "new OKR", "add OKR", "create
 * objective", "draft OKR", "create a goal" (the legacy goals lookup
 * tool handles "what are our OKRs"; this one explicitly creates).
 *
 * Capability: CEO / CTO / EVP only (matches /api/goals/okrs POST).
 * The tool returns the form regardless of role — the submit endpoint
 * enforces the role gate so the failure message is consistent with
 * the upstream API.
 */

import { z } from "zod";
import { trackEvent } from "@/lib/analytics";
import { registerTool } from "./registry";
import type { ToolDef, ToolResult } from "./types";
import { okrFormSpec } from "@/lib/assistant/forms/specs";

const ParamSchema = z.object({
  title: z.string().min(1).max(200).optional(),
});
type Params = z.infer<typeof ParamSchema>;

interface CreateOkrFormData {
  formKind: "create_okr";
}

const INTENT_RE =
  /\b(?:create|new|add|draft|set\s+up)\s+(?:an?\s+)?(?:okr|objective|company\s+goal|quarterly\s+goal)\b/i;
const TITLE_RE = /\b(?:titled|called|named|for|to)\s+["']?([^"'\n]{2,120})["']?/i;

function matchOkrFormIntent(message: string): Params | null {
  if (!INTENT_RE.test(message)) return null;
  const params: Params = {};
  const t = TITLE_RE.exec(message);
  if (t) params.title = t[1].trim();
  return params;
}

export const createOkrFormTool: ToolDef<Params, CreateOkrFormData> = {
  name: "create_okr_form",
  description:
    "Surface a form in the chat for creating a quarterly OKR. Quarter, objective, and one KR are required.",
  paramSchema: ParamSchema,
  capability: "*",
  matchIntent: matchOkrFormIntent,
  async handler(params, ctx): Promise<ToolResult<CreateOkrFormData>> {
    trackEvent("assistant.form_offered", ctx.userId, ctx.userRole, {
      form_kind: "create_okr",
      prefilled_title: params.title ? true : false,
    });
    return {
      ok: true,
      data: { formKind: "create_okr" },
      answer:
        "Fill in the OKR below. CEO, CTO, or EVP role required.",
      form: okrFormSpec({ title: params.title }),
    };
  },
};

registerTool(createOkrFormTool);
