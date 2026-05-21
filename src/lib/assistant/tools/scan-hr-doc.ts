/**
 * scan-hr-doc — assistant tool for HR doc intake. Triggers:
 * "scan hr doc", "upload hr doc", "scan license", "scan passport",
 * "scan w-2", "scan w9", "scan i-9", "scan voided check", "/hr",
 * "/i9", "/w9", "/w2", "/license".
 */

import { z } from "zod";
import { trackEvent } from "@/lib/analytics";
import { registerTool } from "./registry";
import type { ToolDef, ToolResult } from "./types";
import type { ScanHrDocWidgetSpec } from "@/lib/assistant/widgets/types";

const ParamSchema = z.object({
  employee_email: z.string().email().optional(),
  doc_type: z.enum([
    "license", "passport", "state_id",
    "w2", "w4", "w9", "i9",
    "voided_check", "direct_deposit", "other",
  ]).optional(),
});
type Params = z.infer<typeof ParamSchema>;

interface ScanHrDocData { kind: "scan_hr_doc"; }

const INTENT_RE =
  /^\s*\/?(?:scan\s+(?:hr|license|passport|w-?2|w-?4|w-?9|i-?9|voided|driver|direct\s+deposit)|upload\s+hr|hr\s+doc|hr|i-?9|w-?9|w-?2|w-?4|license|passport)\b\s*(.*)$/i;

const DOC_KEYWORDS: Array<[RegExp, Params["doc_type"]]> = [
  [/license|driver/i, "license"],
  [/passport/i, "passport"],
  [/state\s*id/i, "state_id"],
  [/w-?2/i, "w2"],
  [/w-?4/i, "w4"],
  [/w-?9/i, "w9"],
  [/i-?9/i, "i9"],
  [/voided\s*check/i, "voided_check"],
  [/direct\s*deposit/i, "direct_deposit"],
];

export function matchScanHrDocIntent(message: string): Params | null {
  const t = (message ?? "").trim();
  if (!t || !INTENT_RE.test(t)) return null;
  const out: Params = {};
  for (const [re, dt] of DOC_KEYWORDS) {
    if (re.test(t)) { out.doc_type = dt; break; }
  }
  const emailMatch = t.match(/\b([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})\b/i);
  if (emailMatch) out.employee_email = emailMatch[1].toLowerCase();
  return out;
}

export const scanHrDocTool: ToolDef<Params, ScanHrDocData> = {
  name: "scan_hr_doc",
  description:
    "Open the HR document upload form. Trigger phrases: 'scan license', 'scan passport', 'scan w-9', 'scan i-9', 'upload hr doc', '/hr'. Optional prefill: include an employee email and/or doc type in the message. License / passport / state ID extract structured fields; other types are OCR'd.",
  paramSchema: ParamSchema,
  capability: "assistant.use",
  matchIntent: matchScanHrDocIntent,
  async handler(params, ctx): Promise<ToolResult<ScanHrDocData>> {
    trackEvent("assistant.widget_offered", ctx.userId, ctx.userRole, {
      widget_kind: "scan_hr_doc",
      prefilled_email: params.employee_email ? "yes" : "no",
      prefilled_doc_type: params.doc_type ?? "none",
      ...(ctx.workflowId ? { workflow_id: ctx.workflowId } : {}),
    });
    const spec: ScanHrDocWidgetSpec = {
      kind: "scan_hr_doc",
      employeeEmail: params.employee_email,
      docType: params.doc_type,
    };
    return {
      ok: true,
      data: { kind: "scan_hr_doc" },
      answer: "Set the employee email, pick a document type, then drop the file. License / passport / state ID extract structured fields; W-9 / W-4 / I-9 / voided checks get OCR'd for search.",
      sources: [],
      widget: spec,
    };
  },
};

registerTool(scanHrDocTool);
