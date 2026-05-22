/**
 * Azure Document Intelligence — prebuilt-tax.us.w2 + prebuilt-tax.us.1099.
 *
 * Backs the tax-document recognition flow on /tools (and the future
 * /finance/tax intake). Returns ExtractedField[] in the same shape
 * the router expects, so the router doesn't have to know which Azure
 * model produced the result.
 *
 * Mirrors form-recognizer.ts exactly:
 *   - Same client wrapper (postAzure / pollAzureOperation).
 *   - Same audit hook (recordAzureCall).
 *   - Same 3.5 MB cap to avoid burning a free-tier transaction on a
 *     known-rejected upload.
 *   - Same MIME allow-list as the receipt + invoice path.
 *
 * Free-tier quota: prebuilt-tax models share the 500-tx/month
 * Document Intelligence free tier. Standard tier is ~$0.01 per page.
 */

import { resolveAzureCreds, postAzure, pollAzureOperation } from "./client";
import { recordAzureCall, type AzureCallContext } from "./audit";
import {
  azureDocumentFieldToExtractedField,
  type AzureDocumentField,
} from "@/lib/document-recognition/normalize";
import type { ExtractedField } from "@/lib/document-recognition/types";

/** Same cap as receipt / invoice. >3.5 MB is rejected before Azure. */
export const TAX_FORM_MAX_BYTES = 3.5 * 1024 * 1024;

/** MIME types Azure prebuilt-tax models accept. */
export const TAX_FORM_SUPPORTED_MIMES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "application/pdf",
]);

const W2_MODEL = "prebuilt-tax.us.w2";
const TAX_1099_MODEL = "prebuilt-tax.us.1099";

/* Canonical W-2 fields we promote to ExtractedField[]. Azure's W-2
 * schema is documented at:
 * https://learn.microsoft.com/azure/ai-services/document-intelligence/prebuilt/tax-document
 * Keys are Azure field names; values are canonical names the router
 * exposes downstream. */
const W2_FIELD_MAP: Readonly<Record<string, string>> = {
  Employee_SocialSecurityNumber: "employee_ssn",
  Employee_Name: "employee_name",
  Employee_Address: "employee_address",
  Employer_IdNumber: "employer_ein",
  Employer_Name: "employer_name",
  Employer_Address: "employer_address",
  ControlNumber: "control_number",
  TaxYear: "tax_year",
  WagesTipsAndOtherCompensation: "wages",
  FederalIncomeTaxWithheld: "federal_income_tax_withheld",
  SocialSecurityWages: "social_security_wages",
  SocialSecurityTaxWithheld: "social_security_tax_withheld",
  MedicareWages: "medicare_wages",
  MedicareTaxWithheld: "medicare_tax_withheld",
  SocialSecurityTips: "social_security_tips",
  AllocatedTips: "allocated_tips",
  StateWagesTipsEtc: "state_wages",
  StateIncomeTax: "state_income_tax",
  LocalWagesTipsEtc: "local_wages",
  LocalIncomeTax: "local_income_tax",
};

/* Canonical 1099 fields. The prebuilt-tax.us.1099 model is a union
 * across 1099-NEC / 1099-MISC / 1099-DIV / 1099-INT — we map the
 * common payer/payee fields plus the most-requested money boxes.
 * Boxes that don't appear on a given variant simply won't be in the
 * Azure response, so they fall out of the ExtractedField[]
 * automatically. */
const TAX_1099_FIELD_MAP: Readonly<Record<string, string>> = {
  Payer_TIN: "payer_tin",
  Payer_Name: "payer_name",
  Payer_Address: "payer_address",
  Payee_TIN: "payee_tin",
  Payee_Name: "payee_name",
  Payee_Address: "payee_address",
  AccountNumber: "account_number",
  TaxYear: "tax_year",
  NonemployeeCompensation: "nonemployee_compensation",
  FederalIncomeTaxWithheld: "federal_income_tax_withheld",
  Rents: "rents",
  Royalties: "royalties",
  OtherIncome: "other_income",
  FishingBoatProceeds: "fishing_boat_proceeds",
  MedicalAndHealthCarePayments: "medical_payments",
  GrossProceedsPaidToAttorney: "gross_proceeds_to_attorney",
  StateTaxWithheld: "state_tax_withheld",
  StateIncome: "state_income",
  Box1: "box_1",
  Box2: "box_2",
  Box3: "box_3",
  Box4: "box_4",
  Box5: "box_5",
  Box6: "box_6",
  Box7: "box_7",
  Box8: "box_8",
};

/** The Azure Document Intelligence async response shape, restricted
 *  to the fields the tax extractors read. Matches form-recognizer.ts. */
interface DocumentIntelligenceResponse {
  status?: string;
  analyzeResult?: {
    documents?: Array<{
      docType?: string;
      fields?: Record<string, AzureDocumentField>;
      confidence?: number;
    }>;
    content?: string;
  };
}

export interface TaxFormResult {
  /** Normalized fields ready to drop into ExtractedDocument.fields. */
  fields: ExtractedField[];
  /** OCR content from Azure, capped for prompt-safety. */
  rawText: string;
  /** Wall-clock latency for the full POST + poll cycle. */
  latencyMs: number;
  /** Azure model id that produced the result. */
  model: string;
}

export function isTaxFormConfigured(): boolean {
  return resolveAzureCreds("form_recognizer") !== null;
}

/* ───────── Errors ───────── */

export class TaxFormNotConfiguredError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "TaxFormNotConfiguredError";
  }
}

export class TaxFormVendorError extends Error {
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
    this.name = "TaxFormVendorError";
  }
}

/**
 * Map an Azure client failure code to our tax-form error class.
 * Azure's `not_configured` becomes `TaxFormNotConfiguredError`;
 * everything else becomes `TaxFormVendorError` with a narrow code.
 * Marked `never` so TypeScript knows control flow stops here.
 */
function throwTaxVendor(
  code:
    | "not_configured"
    | "rate_limited"
    | "forbidden"
    | "bad_request"
    | "timeout"
    | "polling_timeout"
    | "graph_unavailable"
    | "internal",
  detail: string,
): never {
  if (code === "not_configured") {
    throw new TaxFormNotConfiguredError(detail);
  }
  throw new TaxFormVendorError(detail, code);
}

/* ───────── Mapping ───────── */

/**
 * Map an Azure DI response for a tax document into our normalized
 * shape. Pure-fn so unit tests can drive canned fixtures.
 */
export function mapTaxFields(
  raw: DocumentIntelligenceResponse,
  fieldMap: Readonly<Record<string, string>>,
): { fields: ExtractedField[]; rawText: string } | null {
  const doc = raw.analyzeResult?.documents?.[0];
  if (!doc) return null;
  const azureFields = doc.fields ?? {};
  const out: ExtractedField[] = [];
  for (const [azureName, canonicalName] of Object.entries(fieldMap)) {
    const field = azureFields[azureName];
    if (!field) continue;
    const ef = azureDocumentFieldToExtractedField(canonicalName, field);
    if (ef.value === "" && ef.rawValue === null) continue;
    out.push(ef);
  }
  return {
    fields: out,
    rawText: (raw.analyzeResult?.content ?? "").slice(0, 4000),
  };
}

/* ───────── Public API ───────── */

async function scanTaxForm(
  model: typeof W2_MODEL | typeof TAX_1099_MODEL,
  fieldMap: Readonly<Record<string, string>>,
  bytes: Uint8Array,
  mime: string,
  ctx: AzureCallContext,
): Promise<TaxFormResult> {
  if (bytes.length > TAX_FORM_MAX_BYTES) {
    throw new TaxFormVendorError(
      `tax form ${bytes.length} bytes exceeds cap ${TAX_FORM_MAX_BYTES} bytes`,
      "too_large",
    );
  }
  if (!TAX_FORM_SUPPORTED_MIMES.has(mime)) {
    throw new TaxFormVendorError(`unsupported MIME type ${mime}`, "unsupported_mime");
  }

  const creds = resolveAzureCreds("form_recognizer");
  if (!creds) {
    throw new TaxFormNotConfiguredError(
      "AZURE_FORM_REC_ENDPOINT/KEY (or AZURE_COGNITIVE_*) not set",
    );
  }

  const t0 = Date.now();
  const buffer = Buffer.from(bytes);
  const post = await postAzure(
    creds,
    `formrecognizer/documentModels/${model}:analyze`,
    {
      body: buffer,
      contentType: mime,
      query: { "api-version": "2023-07-31" },
    },
  );
  if (!post.ok) {
    /* Best-effort audit; never throw on audit failure. */
    try {
      await recordAzureCall(ctx, post, 0);
    } catch {
      /* swallow */
    }
    throwTaxVendor(post.error.code, post.error.detail);
  }

  const poll = await pollAzureOperation<DocumentIntelligenceResponse>(
    creds,
    post.value.operationLocation,
    { intervalMs: 750, maxAttempts: 40 },
  );
  if (!poll.ok) {
    try {
      await recordAzureCall(ctx, poll, 0);
    } catch {
      /* swallow */
    }
    throwTaxVendor(poll.error.code, poll.error.detail);
  }

  const mapped = mapTaxFields(poll.value, fieldMap);
  try {
    await recordAzureCall(ctx, poll, mapped?.rawText.length ?? 0);
  } catch {
    /* swallow */
  }
  if (!mapped) {
    throw new TaxFormVendorError(
      `Azure ${model} returned no documents — file may not be a ${model.endsWith("w2") ? "W-2" : "1099"}`,
      "no_document_detected",
    );
  }
  return {
    fields: mapped.fields,
    rawText: mapped.rawText,
    latencyMs: Date.now() - t0,
    model,
  };
}

export async function scanTaxW2(
  bytes: Uint8Array,
  mime: string,
  ctx: AzureCallContext,
): Promise<TaxFormResult> {
  const taxCtx: AzureCallContext = { ...ctx, operation: W2_MODEL };
  return scanTaxForm(W2_MODEL, W2_FIELD_MAP, bytes, mime, taxCtx);
}

export async function scanTax1099(
  bytes: Uint8Array,
  mime: string,
  ctx: AzureCallContext,
): Promise<TaxFormResult> {
  const taxCtx: AzureCallContext = { ...ctx, operation: TAX_1099_MODEL };
  return scanTaxForm(TAX_1099_MODEL, TAX_1099_FIELD_MAP, bytes, mime, taxCtx);
}
