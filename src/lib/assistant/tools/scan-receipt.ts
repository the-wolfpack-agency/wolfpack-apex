/**
 * scan-receipt — assistant tool that opens the ScanReceiptWidget.
 *
 * Trigger phrases: "scan receipt", "scan document", "upload receipt",
 * "/receipt", "/scan". Free-text prefill: "scan receipt for
 * WOLFPACK-AUTO" pre-picks the code.
 *
 * Widget itself handles the Azure Form Recognizer round-trip + the
 * cell PATCH commits. This tool only emits the widget spec + records
 * that the offer was made (for the offer→render→apply funnel).
 */

import { z } from "zod";
import { trackEvent } from "@/lib/analytics";
import { registerTool } from "./registry";
import type { ToolDef, ToolResult } from "./types";
import type { ScanReceiptWidgetSpec } from "@/lib/assistant/widgets/types";

const ParamSchema = z.object({
  job_code: z.string().max(64).optional(),
});
type Params = z.infer<typeof ParamSchema>;

interface ScanReceiptData {
  kind: "scan_receipt";
}

const INTENT_RE =
  /^\s*\/?(?:scan\s+(?:receipt|document|invoice)|upload\s+(?:receipt|invoice)|receipt|invoice|scan)\b\s*(.*)$/i;

export function matchScanReceiptIntent(message: string): Params | null {
  const trimmed = (message ?? "").trim();
  if (!trimmed) return null;
  const m = trimmed.match(INTENT_RE);
  if (!m) return null;
  const tail = (m[1] ?? "").trim();
  const out: Params = {};
  /* Best-effort prefill: "scan receipt for WOLFPACK-AUTO" or
     "scan receipt WOLFPACK-AUTO". */
  const codeMatch = tail.match(/\b(?:for|to|on)?\s*([A-Z0-9][A-Z0-9_\- ]{1,60})$/i);
  if (codeMatch) out.job_code = codeMatch[1].trim();
  return out;
}

export const scanReceiptTool: ToolDef<Params, ScanReceiptData> = {
  name: "scan_receipt",
  description:
    "Open a receipt-scan form. Trigger phrases: 'scan receipt', 'scan document', 'upload receipt'. Optional prefill: 'scan receipt for WOLFPACK-AUTO'. Extracted merchant/total/date are applied to the chosen job code's Program / PO Number / PO Amount columns in the SharePoint workbook.",
  paramSchema: ParamSchema,
  capability: "assistant.use",
  matchIntent: matchScanReceiptIntent,
  async handler(params, ctx): Promise<ToolResult<ScanReceiptData>> {
    trackEvent("assistant.widget_offered", ctx.userId, ctx.userRole, {
      widget_kind: "scan_receipt",
      prefilled_job_code: params.job_code ? "yes" : "no",
      ...(ctx.workflowId ? { workflow_id: ctx.workflowId } : {}),
    });
    const spec: ScanReceiptWidgetSpec = {
      kind: "scan_receipt",
      jobCode: params.job_code,
    };
    return {
      ok: true,
      data: { kind: "scan_receipt" },
      answer:
        "Drop a receipt below and I'll pull the merchant, date, and total. You'll pick a job code, then save the values to SharePoint (Program / PO Number / PO Amount only — Client/Category and Job Code stay untouched).",
      sources: [],
      widget: spec,
    };
  },
};

registerTool(scanReceiptTool);
