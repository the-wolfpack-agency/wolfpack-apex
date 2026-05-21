/**
 * Azure Document Intelligence — prebuilt-receipt model.
 *
 * Backs the "scan receipt" flow on /job-codes that pre-fills the
 * editable D/E/F columns (Program / PO Number / PO Amount) from a
 * photo of a receipt or PDF invoice.
 *
 * Free-tier quota: 500 transactions/month (prebuilt models).
 * Larger documents (>4 MB or >2k pages) are rejected by Azure; we
 * cap at 3.5 MB before the call to avoid burning a free transaction
 * on a known-rejected upload.
 *
 * Model: prebuilt-receipt. Returns structured fields like
 * MerchantName, TransactionDate, Total, Items[]. We surface a curated
 * subset to the UI — bare fields the user can review and apply.
 */

import { resolveAzureCreds, postAzure, pollAzureOperation } from "./client";
import { recordAzureCall, type AzureCallContext } from "./audit";

export const RECEIPT_MAX_BYTES = 3.5 * 1024 * 1024;

interface DocumentField {
  type?: string;
  valueString?: string;
  valueNumber?: number;
  valueDate?: string;
  valueCurrency?: { amount?: number; currencyCode?: string };
  content?: string;
  confidence?: number;
  valueArray?: DocumentField[];
  valueObject?: Record<string, DocumentField>;
}
interface DocumentIntelligenceResponse {
  status?: string;
  analyzeResult?: {
    documents?: Array<{
      docType?: string;
      fields?: Record<string, DocumentField>;
      confidence?: number;
    }>;
    content?: string;
  };
}

export interface ReceiptItem {
  description: string;
  totalPrice: number | null;
  quantity: number | null;
}

export interface ReceiptFields {
  merchantName: string | null;
  transactionDate: string | null;
  total: number | null;
  subtotal: number | null;
  tax: number | null;
  currency: string | null;
  items: ReceiptItem[];
  /** Confidence the model assigned to the overall document (0..1). */
  documentConfidence: number | null;
  /** Verbatim OCR text the receipt contained, capped — useful when
   *  the user wants to copy a PO number that the model didn't surface
   *  as a structured field. */
  rawText: string;
}

export interface ReceiptScanSuccess {
  ok: true;
  fields: ReceiptFields;
}
export interface ReceiptScanFailure {
  ok: false;
  reason:
    | "not_configured"
    | "too_large"
    | "rate_limited"
    | "forbidden"
    | "bad_request"
    | "unavailable"
    | "polling_timeout"
    | "no_document_detected"
    | "internal";
  detail: string;
}
export type ReceiptScanResult = ReceiptScanSuccess | ReceiptScanFailure;

/* ── Invoice (prebuilt-invoice) ──────────────────────────────── */

export interface InvoiceLineItem {
  description: string;
  amount: number | null;
  quantity: number | null;
  unitPrice: number | null;
  productCode: string | null;
}

export interface InvoiceFields {
  vendorName: string | null;
  customerName: string | null;
  invoiceId: string | null;
  invoiceDate: string | null;
  dueDate: string | null;
  subtotal: number | null;
  totalTax: number | null;
  invoiceTotal: number | null;
  currency: string | null;
  lineItems: InvoiceLineItem[];
  documentConfidence: number | null;
  /** Verbatim OCR content, capped — useful when the model didn't
   *  promote a field the human needs. */
  rawText: string;
  /** The full raw fields payload from Form Recognizer, preserved as-
   *  is so the UI can surface anything the model returned beyond the
   *  promoted columns. */
  rawFields: Record<string, unknown>;
}

export interface InvoiceScanSuccess {
  ok: true;
  fields: InvoiceFields;
}
export type InvoiceScanResult = InvoiceScanSuccess | ReceiptScanFailure;

export function isFormRecognizerConfigured(): boolean {
  return resolveAzureCreds("form_recognizer") !== null;
}

function fieldString(f?: DocumentField): string | null {
  if (!f) return null;
  return (f.valueString ?? f.content ?? "").trim() || null;
}
function fieldNumber(f?: DocumentField): number | null {
  if (!f) return null;
  if (typeof f.valueNumber === "number") return f.valueNumber;
  if (f.valueCurrency && typeof f.valueCurrency.amount === "number") return f.valueCurrency.amount;
  return null;
}
function fieldCurrency(f?: DocumentField): string | null {
  if (!f) return null;
  return f.valueCurrency?.currencyCode ?? null;
}
function fieldDate(f?: DocumentField): string | null {
  if (!f) return null;
  return f.valueDate ?? null;
}

/** Pull the receipt fields out of the raw Azure response shape. Kept
 *  separate from the HTTP call so unit tests can feed canned
 *  responses through this pure mapper. */
export function mapReceiptFields(
  raw: DocumentIntelligenceResponse,
): ReceiptFields | null {
  const doc = raw.analyzeResult?.documents?.[0];
  if (!doc) return null;
  const f = doc.fields ?? {};
  const items: ReceiptItem[] = [];
  const itemsArr = f.Items?.valueArray ?? [];
  for (const it of itemsArr) {
    const obj = it.valueObject ?? {};
    items.push({
      description: fieldString(obj.Description) ?? fieldString(obj.Name) ?? "",
      totalPrice: fieldNumber(obj.TotalPrice ?? obj.Price),
      quantity: fieldNumber(obj.Quantity),
    });
  }
  return {
    merchantName: fieldString(f.MerchantName) ?? fieldString(f.VendorName),
    transactionDate: fieldDate(f.TransactionDate) ?? fieldDate(f.InvoiceDate),
    total: fieldNumber(f.Total) ?? fieldNumber(f.InvoiceTotal),
    subtotal: fieldNumber(f.Subtotal),
    tax: fieldNumber(f.TotalTax) ?? fieldNumber(f.Tax),
    currency: fieldCurrency(f.Total) ?? fieldCurrency(f.InvoiceTotal),
    items,
    documentConfidence: typeof doc.confidence === "number" ? doc.confidence : null,
    rawText: (raw.analyzeResult?.content ?? "").slice(0, 2000),
  };
}

export interface ScanReceiptOptions {
  triggeredBy: string;
  triggeredByRole: string;
  contentType: string;
}

export async function scanReceipt(
  buffer: Buffer,
  opts: ScanReceiptOptions,
): Promise<ReceiptScanResult> {
  if (buffer.length > RECEIPT_MAX_BYTES) {
    return {
      ok: false,
      reason: "too_large",
      detail: `receipt ${buffer.length} bytes exceeds cap ${RECEIPT_MAX_BYTES} bytes`,
    };
  }
  const creds = resolveAzureCreds("form_recognizer");
  if (!creds) {
    return {
      ok: false,
      reason: "not_configured",
      detail: "AZURE_FORM_REC_ENDPOINT/KEY (or AZURE_COGNITIVE_*) not set",
    };
  }

  const ctx: AzureCallContext = {
    service: "form_recognizer",
    operation: "prebuilt-receipt",
    triggeredBy: opts.triggeredBy,
    triggeredByRole: opts.triggeredByRole,
    requestBytes: buffer.length,
  };

  const post = await postAzure(creds, "formrecognizer/documentModels/prebuilt-receipt:analyze", {
    body: buffer,
    contentType: opts.contentType,
    query: { "api-version": "2023-07-31" },
  });
  if (!post.ok) {
    await recordAzureCall(ctx, post, 0);
    return mapFailure(post.error.code, post.error.detail);
  }

  const poll = await pollAzureOperation<DocumentIntelligenceResponse>(
    creds,
    post.value.operationLocation,
    { intervalMs: 750, maxAttempts: 40 },
  );
  if (!poll.ok) {
    await recordAzureCall(ctx, poll, 0);
    return mapFailure(poll.error.code, poll.error.detail);
  }

  const fields = mapReceiptFields(poll.value);
  await recordAzureCall(ctx, poll, fields?.rawText.length ?? 0);
  if (!fields) {
    return {
      ok: false,
      reason: "no_document_detected",
      detail: "Form Recognizer returned no documents — image may not be a receipt",
    };
  }
  return { ok: true, fields };
}

/**
 * Map a prebuilt-invoice response into our promoted-column shape.
 * Pure-fn; testable with canned Azure response fixtures.
 */
export function mapInvoiceFields(
  raw: DocumentIntelligenceResponse,
): InvoiceFields | null {
  const doc = raw.analyzeResult?.documents?.[0];
  if (!doc) return null;
  const f = doc.fields ?? {};
  const lineItems: InvoiceLineItem[] = [];
  const itemsArr = f.Items?.valueArray ?? [];
  for (const it of itemsArr) {
    const obj = it.valueObject ?? {};
    lineItems.push({
      description: fieldString(obj.Description) ?? "",
      amount: fieldNumber(obj.Amount),
      quantity: fieldNumber(obj.Quantity),
      unitPrice: fieldNumber(obj.UnitPrice),
      productCode: fieldString(obj.ProductCode),
    });
  }
  return {
    vendorName: fieldString(f.VendorName),
    customerName: fieldString(f.CustomerName),
    invoiceId: fieldString(f.InvoiceId),
    invoiceDate: fieldDate(f.InvoiceDate),
    dueDate: fieldDate(f.DueDate),
    subtotal: fieldNumber(f.SubTotal ?? f.Subtotal),
    totalTax: fieldNumber(f.TotalTax),
    invoiceTotal: fieldNumber(f.InvoiceTotal ?? f.AmountDue),
    currency: fieldCurrency(f.InvoiceTotal ?? f.AmountDue ?? f.SubTotal),
    lineItems,
    documentConfidence: typeof doc.confidence === "number" ? doc.confidence : null,
    rawText: (raw.analyzeResult?.content ?? "").slice(0, 4000),
    rawFields: f as Record<string, unknown>,
  };
}

/**
 * Scan an invoice via prebuilt-invoice. Same async/poll pattern as
 * scanReceipt; separate function so the audit operation field is
 * recorded distinctly (prebuilt-invoice is a different free-tier
 * meter from prebuilt-receipt).
 */
export async function scanInvoice(
  buffer: Buffer,
  opts: ScanReceiptOptions,
): Promise<InvoiceScanResult> {
  if (buffer.length > RECEIPT_MAX_BYTES) {
    return { ok: false, reason: "too_large", detail: `invoice ${buffer.length} bytes exceeds cap ${RECEIPT_MAX_BYTES} bytes` };
  }
  const creds = resolveAzureCreds("form_recognizer");
  if (!creds) {
    return { ok: false, reason: "not_configured", detail: "AZURE_FORM_REC_ENDPOINT/KEY (or AZURE_COGNITIVE_*) not set" };
  }
  const ctx: AzureCallContext = {
    service: "form_recognizer",
    operation: "prebuilt-invoice",
    triggeredBy: opts.triggeredBy,
    triggeredByRole: opts.triggeredByRole,
    requestBytes: buffer.length,
  };
  const post = await postAzure(creds, "formrecognizer/documentModels/prebuilt-invoice:analyze", {
    body: buffer,
    contentType: opts.contentType,
    query: { "api-version": "2023-07-31" },
  });
  if (!post.ok) {
    await recordAzureCall(ctx, post, 0);
    return mapFailure(post.error.code, post.error.detail);
  }
  const poll = await pollAzureOperation<DocumentIntelligenceResponse>(creds, post.value.operationLocation, { intervalMs: 750, maxAttempts: 40 });
  if (!poll.ok) {
    await recordAzureCall(ctx, poll, 0);
    return mapFailure(poll.error.code, poll.error.detail);
  }
  const fields = mapInvoiceFields(poll.value);
  await recordAzureCall(ctx, poll, fields?.rawText.length ?? 0);
  if (!fields) {
    return { ok: false, reason: "no_document_detected", detail: "Form Recognizer returned no documents — file may not be an invoice" };
  }
  return { ok: true, fields };
}

function mapFailure(code: string, detail: string): ReceiptScanFailure {
  switch (code) {
    case "not_configured":
      return { ok: false, reason: "not_configured", detail };
    case "rate_limited":
      return { ok: false, reason: "rate_limited", detail };
    case "forbidden":
      return { ok: false, reason: "forbidden", detail };
    case "bad_request":
      return { ok: false, reason: "bad_request", detail };
    case "polling_timeout":
      return { ok: false, reason: "polling_timeout", detail };
    case "timeout":
    case "graph_unavailable":
      return { ok: false, reason: "unavailable", detail };
    default:
      return { ok: false, reason: "internal", detail };
  }
}
