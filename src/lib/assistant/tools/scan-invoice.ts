/**
 * scan-invoice — assistant tool for AP intake. Trigger phrases:
 * "scan invoice", "log invoice", "process invoice", "ap invoice",
 * "/invoice", "/ap".
 *
 * Distinct from scan_receipt: receipts go to job-codes Program/PO
 * Amount; invoices go to the AP queue at /finance/invoices.
 */

import { z } from "zod";
import { trackEvent } from "@/lib/analytics";
import { registerTool } from "./registry";
import type { ToolDef, ToolResult } from "./types";
import type { ScanInvoiceWidgetSpec } from "@/lib/assistant/widgets/types";

const ParamSchema = z.object({});
type Params = z.infer<typeof ParamSchema>;

interface ScanInvoiceData {
  kind: "scan_invoice";
}

const INTENT_RE =
  /^\s*\/?(?:scan\s+invoice|log\s+invoice|process\s+invoice|ap\s+invoice|invoice|ap)\b/i;

export function matchScanInvoiceIntent(message: string): Params | null {
  const trimmed = (message ?? "").trim();
  if (!trimmed) return null;
  return INTENT_RE.test(trimmed) ? {} : null;
}

export const scanInvoiceTool: ToolDef<Params, ScanInvoiceData> = {
  name: "scan_invoice",
  description:
    "Open the invoice upload form. Trigger phrases: 'scan invoice', 'log invoice', 'process invoice'. The uploaded invoice lands in /finance/invoices for human review (status=pending), with vendor / invoice number / dates / totals / line items extracted by Azure Document Intelligence.",
  paramSchema: ParamSchema,
  capability: "assistant.use",
  matchIntent: matchScanInvoiceIntent,
  async handler(_params, ctx): Promise<ToolResult<ScanInvoiceData>> {
    trackEvent("assistant.widget_offered", ctx.userId, ctx.userRole, {
      widget_kind: "scan_invoice",
      ...(ctx.workflowId ? { workflow_id: ctx.workflowId } : {}),
    });
    const spec: ScanInvoiceWidgetSpec = { kind: "scan_invoice" };
    return {
      ok: true,
      data: { kind: "scan_invoice" },
      answer: "Drop the invoice below and I'll send it to the AP queue. Vendor, invoice number, dates, totals, and line items get extracted automatically. You'll review on /finance/invoices before approval.",
      sources: [],
      widget: spec,
    };
  },
};

registerTool(scanInvoiceTool);
