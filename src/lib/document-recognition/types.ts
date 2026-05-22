/**
 * Document Recognition — shared types.
 *
 * Contract between the four layers:
 *   1. classifier.ts        — vision LLM call, decides docType + confidence
 *   2. router.ts            — dispatches to the right extractor by docType
 *   3. extractors (Azure + Claude) — return normalized ExtractedDocument
 *   4. /api/documents/recognize  — orchestrates, persists, returns
 *
 * Persistence shape mirrors RecognizedDocument so the DB row is the truth.
 *
 * Workspace scoping is mandatory on every row. PII pre-scan runs before
 * any vendor call. Audit log entries are written via the existing
 * src/lib/azure/audit.ts pattern.
 */

/* ---------------------------- Document types ---------------------------- */

/** The set of document types the v1 system can classify and route. */
export type DocumentType =
  | "receipt"
  | "invoice"
  | "tax_w2"
  | "tax_1099"
  | "id_document"
  | "unknown";

export const DOCUMENT_TYPES: readonly DocumentType[] = [
  "receipt",
  "invoice",
  "tax_w2",
  "tax_1099",
  "id_document",
  "unknown",
] as const;

/** The extractor responsible for a given classification. */
export type ExtractorKey =
  | "azure_prebuilt_receipt"
  | "azure_prebuilt_invoice"
  | "azure_prebuilt_tax_us_w2"
  | "azure_prebuilt_tax_us_1099"
  | "azure_prebuilt_id_document"
  | "none";

/* ----------------------------- Classifier ------------------------------ */

export interface ClassifierCandidate {
  type: DocumentType;
  confidence: number; // 0..1
}

export interface DocumentClassification {
  /** Best guess. */
  type: DocumentType;
  /** Confidence of the best guess, 0..1. */
  confidence: number;
  /** Up to 3 alternates ordered by descending confidence (excluding `type`). */
  alternates: ClassifierCandidate[];
  /** Short human-readable rationale from the model. <= 240 chars. */
  rationale: string;
  /** Model identifier the classifier called. */
  model: string;
  /** Latency of the classification call in milliseconds. */
  latencyMs: number;
  /** Estimated cost of the classification call in USD cents. */
  costCents: number;
}

/* ----------------------------- Extraction ------------------------------ */

/** Normalized extracted-field set. Each extractor maps its native fields
 *  into this shape so downstream code never branches on extractor type. */
export interface ExtractedField {
  /** Canonical field name (e.g. "vendor", "total", "ssn"). */
  name: string;
  /** String representation; numbers/dates rendered as ISO/decimal strings. */
  value: string;
  /** Optional native value (preserves number/date/currency without parsing). */
  rawValue?: string | number | boolean | null;
  /** 0..1 confidence as reported by the extractor. */
  confidence: number;
}

export interface ExtractedDocument {
  /** Which extractor produced this result. */
  extractor: ExtractorKey;
  /** The Azure model id or Claude model id that ran the extraction. */
  model: string;
  /** Normalized field set. */
  fields: ExtractedField[];
  /** Free-form raw text (OCR text or stitched content). */
  rawText: string;
  /** Latency of the extractor call in milliseconds. */
  latencyMs: number;
  /** Estimated cost in USD cents (0 for free-tier Azure calls). */
  costCents: number;
}

/* ------------------------------ Composite ------------------------------ */

/** The full result of running a file through the recognition pipeline. */
export interface RecognizedDocument {
  id: string;
  workspaceId: string;
  userId: string;
  sourceFile: {
    filename: string;
    mime: string;
    bytes: number;
    /** SHA-256 of the original bytes; used for dedup + audit. */
    sha256: string;
  };
  classification: DocumentClassification;
  extraction: ExtractedDocument | null;
  /** Set when the PII pre-scan flagged the upload and short-circuited
   *  before any vendor call. extraction is null in this case. */
  piiBlocked: boolean;
  /** ISO 8601 timestamp. */
  recognizedAt: string;
}

/* -------------------------------- Errors ------------------------------- */

export type RecognitionErrorKind =
  | "not_configured"
  | "unsupported_mime"
  | "oversize"
  | "pii_blocked"
  | "classifier_failed"
  | "extractor_failed"
  | "vendor_5xx";

export class DocumentRecognitionError extends Error {
  constructor(
    public readonly kind: RecognitionErrorKind,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "DocumentRecognitionError";
  }
}

/* ------------------------------- Routing ------------------------------- */

/** Static map from classified type to extractor key. */
export const TYPE_TO_EXTRACTOR: Readonly<Record<DocumentType, ExtractorKey>> = {
  receipt: "azure_prebuilt_receipt",
  invoice: "azure_prebuilt_invoice",
  tax_w2: "azure_prebuilt_tax_us_w2",
  tax_1099: "azure_prebuilt_tax_us_1099",
  id_document: "azure_prebuilt_id_document",
  unknown: "none",
} as const;

/** Max accepted file size in bytes. Mirrors form-recognizer.ts cap. */
export const MAX_DOCUMENT_BYTES = 3.5 * 1024 * 1024;

/** Supported MIME types. */
export const SUPPORTED_MIMES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "application/pdf",
]);
