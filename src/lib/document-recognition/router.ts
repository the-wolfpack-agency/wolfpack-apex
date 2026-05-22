/**
 * Document Recognition — extractor router.
 *
 * Step 2 of the document-recognition pipeline. Given a
 * DocumentClassification produced by the classifier plus the raw
 * bytes + MIME, dispatch to the right Azure prebuilt extractor and
 * return a normalized ExtractedDocument the API handler can persist.
 *
 * Routing decision comes from the TYPE_TO_EXTRACTOR constant in
 * types.ts so the classifier ↔ extractor mapping has a single source
 * of truth. Never hardcode the mapping here.
 *
 * Cost: every Azure prebuilt model is billed per-page on the standard
 * tier (~$0.01 / page). For v1 we assume 1 page per call and stamp
 * AZURE_PREBUILT_USD_PER_PAGE on every ExtractedDocument. The free
 * tier returns the same value but the audit-log entry tells us when
 * we crossed into paid territory.
 *
 * Errors:
 *   - Azure DI not configured → ExtractorNotConfiguredError.
 *   - Azure 5xx / timeout / malformed → ExtractorVendorError.
 *   - Classification.type === "unknown" → returns null (no extractor
 *     for the unknown class in v1; the API surfaces this as a UI
 *     "couldn't classify" state without burning a transaction).
 *
 * Audit: every dispatched extractor writes an instinct_azure_calls
 * row via recordAzureCall. The underlying scanner functions
 * (scanReceipt / scanInvoice / scanIdDocument / scanTax*) handle
 * that internally. An audit failure inside a scanner is swallowed
 * (per the audit module's design) so a DB hiccup never blocks the
 * extractor result.
 */

import {
  scanReceipt,
  scanInvoice,
  scanIdDocument,
  type ReceiptScanResult,
  type InvoiceScanResult,
  type IdDocScanResult,
  type ReceiptFields,
  type InvoiceFields,
  type IdDocumentFields,
} from "@/lib/azure/form-recognizer";
import {
  scanTaxW2,
  scanTax1099,
  TaxFormNotConfiguredError,
  TaxFormVendorError,
  type TaxFormResult,
} from "@/lib/azure/tax-form";
import type { AzureCallContext } from "@/lib/azure/audit";
import {
  buildExtractedDocument,
} from "./normalize";
import {
  TYPE_TO_EXTRACTOR,
  type DocumentClassification,
  type ExtractedDocument,
  type ExtractedField,
  type ExtractorKey,
} from "./types";

/** USD cents per page on the standard tier of Azure DI prebuilt
 *  models. Free-tier transactions get the same accounting value but
 *  the audit row carries the actual http_status / response_chars so
 *  cost reports can de-dup against the free quota. */
export const AZURE_PREBUILT_USD_PER_PAGE = 1.0;

/* ───────── Errors ───────── */

/**
 * Azure DI credentials were not configured. UI should surface a
 * "service unavailable" state rather than retrying.
 */
export class ExtractorNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtractorNotConfiguredError";
  }
}

/**
 * Azure DI returned a 5xx, timed out, was rate-limited, or sent back
 * a malformed payload. Caller may retry with backoff or surface a
 * "try again later" message.
 */
export class ExtractorVendorError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "rate_limited"
      | "forbidden"
      | "bad_request"
      | "timeout"
      | "polling_timeout"
      | "graph_unavailable"
      | "internal"
      | "no_document_detected"
      | "malformed_response"
      | "too_large"
      | "unsupported_mime",
  ) {
    super(message);
    this.name = "ExtractorVendorError";
  }
}

/* ───────── Input ───────── */

export interface ExtractInput {
  bytes: Uint8Array;
  mime: string;
  classification: DocumentClassification;
  /** Audit context — who triggered the scan. Required so every
   *  extractor call writes a complete instinct_azure_calls row. */
  audit: Pick<AzureCallContext, "triggeredBy" | "triggeredByRole" | "documentId">;
}

/* ───────── Receipt / Invoice / ID Document → ExtractedField[] ─────────
 *
 * The receipt/invoice/id scanners return curated structured shapes
 * (ReceiptFields, InvoiceFields, IdDocumentFields) rather than the
 * raw Azure DocumentField map. We convert each to ExtractedField[]
 * with a confidence proxy from the document-level confidence so the
 * router output is uniform regardless of extractor.
 *
 * Confidence note: the structured shape collapses per-field
 * confidence into a document-level number; we propagate that across
 * fields. Once the structured shape exposes per-field confidence we
 * can replace this with the per-field value without changing the
 * router's contract.
 */

function pushIfPresent(
  fields: ExtractedField[],
  name: string,
  value: string | number | null,
  documentConfidence: number | null,
): void {
  if (value === null || value === undefined) return;
  const str = typeof value === "string" ? value : String(value);
  if (str.length === 0) return;
  fields.push({
    name,
    value: str,
    rawValue: value,
    confidence: typeof documentConfidence === "number" ? documentConfidence : 0,
  });
}

function receiptFieldsToExtracted(r: ReceiptFields): ExtractedField[] {
  const conf = r.documentConfidence;
  const out: ExtractedField[] = [];
  pushIfPresent(out, "merchant_name", r.merchantName, conf);
  pushIfPresent(out, "transaction_date", r.transactionDate, conf);
  pushIfPresent(out, "total", r.total, conf);
  pushIfPresent(out, "subtotal", r.subtotal, conf);
  pushIfPresent(out, "tax", r.tax, conf);
  pushIfPresent(out, "currency", r.currency, conf);
  return out;
}

function invoiceFieldsToExtracted(i: InvoiceFields): ExtractedField[] {
  const conf = i.documentConfidence;
  const out: ExtractedField[] = [];
  pushIfPresent(out, "vendor_name", i.vendorName, conf);
  pushIfPresent(out, "customer_name", i.customerName, conf);
  pushIfPresent(out, "invoice_id", i.invoiceId, conf);
  pushIfPresent(out, "invoice_date", i.invoiceDate, conf);
  pushIfPresent(out, "due_date", i.dueDate, conf);
  pushIfPresent(out, "subtotal", i.subtotal, conf);
  pushIfPresent(out, "total_tax", i.totalTax, conf);
  pushIfPresent(out, "invoice_total", i.invoiceTotal, conf);
  pushIfPresent(out, "currency", i.currency, conf);
  return out;
}

function idDocFieldsToExtracted(d: IdDocumentFields): ExtractedField[] {
  const conf = d.documentConfidence;
  const out: ExtractedField[] = [];
  pushIfPresent(out, "document_number", d.documentNumber, conf);
  pushIfPresent(out, "first_name", d.firstName, conf);
  pushIfPresent(out, "last_name", d.lastName, conf);
  pushIfPresent(out, "full_name", d.fullName, conf);
  pushIfPresent(out, "date_of_birth", d.dateOfBirth, conf);
  pushIfPresent(out, "date_of_expiration", d.dateOfExpiration, conf);
  pushIfPresent(out, "date_of_issue", d.dateOfIssue, conf);
  pushIfPresent(out, "country_region", d.countryRegion, conf);
  pushIfPresent(out, "region", d.region, conf);
  pushIfPresent(out, "document_type", d.documentType, conf);
  return out;
}

/* ───────── Failure mapping ─────────
 *
 * The receipt/invoice/id scanners return a tagged union with a
 * `reason` field. We turn vendor reasons into ExtractorVendorError
 * and not_configured into ExtractorNotConfiguredError. Anything else
 * falls through as an internal error.
 */

function throwFromScannerFailure(
  reason:
    | "not_configured"
    | "too_large"
    | "rate_limited"
    | "forbidden"
    | "bad_request"
    | "unavailable"
    | "polling_timeout"
    | "no_document_detected"
    | "internal",
  detail: string,
): never {
  if (reason === "not_configured") {
    throw new ExtractorNotConfiguredError(detail);
  }
  /* Map "unavailable" to graph_unavailable so the ExtractorVendorError
   * code is a stable string for callers / dashboards. */
  const code =
    reason === "unavailable" ? "graph_unavailable" : (reason as Exclude<typeof reason, "not_configured" | "unavailable">);
  throw new ExtractorVendorError(detail, code);
}

/* ───────── Entry point ───────── */

/**
 * Dispatch a classified document to the right Azure extractor and
 * return a normalized ExtractedDocument. Returns null when the
 * classification type is "unknown" (no v1 extractor for unknown).
 *
 * Thrown errors are typed: ExtractorNotConfiguredError when Azure DI
 * isn't set up, ExtractorVendorError for any vendor-side failure
 * (5xx / timeout / malformed). Caller decides whether to retry or
 * surface to the UI.
 */
export async function extractDocument(
  input: ExtractInput,
): Promise<ExtractedDocument | null> {
  const extractor: ExtractorKey = TYPE_TO_EXTRACTOR[input.classification.type];
  if (extractor === "none") return null;

  const ctxBase: AzureCallContext = {
    service: "form_recognizer",
    operation: extractor,
    triggeredBy: input.audit.triggeredBy ?? null,
    triggeredByRole: input.audit.triggeredByRole ?? null,
    documentId: input.audit.documentId ?? null,
    requestBytes: input.bytes.length,
  };

  const t0 = Date.now();
  const buffer = Buffer.from(input.bytes);

  switch (extractor) {
    case "azure_prebuilt_receipt": {
      const r: ReceiptScanResult = await scanReceipt(buffer, {
        triggeredBy: ctxBase.triggeredBy ?? "system",
        triggeredByRole: ctxBase.triggeredByRole ?? "system",
        contentType: input.mime,
      });
      if (!r.ok) throwFromScannerFailure(r.reason, r.detail);
      return buildExtractedDocument({
        extractor,
        model: "prebuilt-receipt",
        fields: receiptFieldsToExtracted(r.fields),
        rawText: r.fields.rawText,
        latencyMs: Date.now() - t0,
        costCents: AZURE_PREBUILT_USD_PER_PAGE,
      });
    }
    case "azure_prebuilt_invoice": {
      const r: InvoiceScanResult = await scanInvoice(buffer, {
        triggeredBy: ctxBase.triggeredBy ?? "system",
        triggeredByRole: ctxBase.triggeredByRole ?? "system",
        contentType: input.mime,
      });
      if (!r.ok) throwFromScannerFailure(r.reason, r.detail);
      return buildExtractedDocument({
        extractor,
        model: "prebuilt-invoice",
        fields: invoiceFieldsToExtracted(r.fields),
        rawText: r.fields.rawText,
        latencyMs: Date.now() - t0,
        costCents: AZURE_PREBUILT_USD_PER_PAGE,
      });
    }
    case "azure_prebuilt_id_document": {
      const r: IdDocScanResult = await scanIdDocument(buffer, {
        triggeredBy: ctxBase.triggeredBy ?? "system",
        triggeredByRole: ctxBase.triggeredByRole ?? "system",
        contentType: input.mime,
      });
      if (!r.ok) throwFromScannerFailure(r.reason, r.detail);
      return buildExtractedDocument({
        extractor,
        model: "prebuilt-idDocument",
        fields: idDocFieldsToExtracted(r.fields),
        rawText: r.fields.rawText,
        latencyMs: Date.now() - t0,
        costCents: AZURE_PREBUILT_USD_PER_PAGE,
      });
    }
    case "azure_prebuilt_tax_us_w2": {
      const result: TaxFormResult = await wrapTaxCall(() =>
        scanTaxW2(input.bytes, input.mime, ctxBase),
      );
      return buildExtractedDocument({
        extractor,
        model: result.model,
        fields: result.fields,
        rawText: result.rawText,
        latencyMs: result.latencyMs,
        costCents: AZURE_PREBUILT_USD_PER_PAGE,
      });
    }
    case "azure_prebuilt_tax_us_1099": {
      const result: TaxFormResult = await wrapTaxCall(() =>
        scanTax1099(input.bytes, input.mime, ctxBase),
      );
      return buildExtractedDocument({
        extractor,
        model: result.model,
        fields: result.fields,
        rawText: result.rawText,
        latencyMs: result.latencyMs,
        costCents: AZURE_PREBUILT_USD_PER_PAGE,
      });
    }
    default: {
      /* Compile-time exhaustiveness — if ExtractorKey gains a new
       * variant the router won't silently swallow it. */
      const _exhaustive: never = extractor;
      throw new ExtractorVendorError(
        `unhandled extractor key: ${String(_exhaustive)}`,
        "internal",
      );
    }
  }
}

/**
 * Convert tax-form's typed errors into the router's typed errors.
 * Keeps the public contract narrow (callers handle two error
 * classes, not three).
 */
async function wrapTaxCall(
  fn: () => Promise<TaxFormResult>,
): Promise<TaxFormResult> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof TaxFormNotConfiguredError) {
      throw new ExtractorNotConfiguredError(err.message);
    }
    if (err instanceof TaxFormVendorError) {
      throw new ExtractorVendorError(err.message, err.code);
    }
    throw new ExtractorVendorError(
      err instanceof Error ? err.message : "unknown tax-form error",
      "internal",
    );
  }
}
