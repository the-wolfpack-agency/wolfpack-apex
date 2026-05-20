/**
 * Central Brain type contracts.
 *
 * Mirrors the DB migration 028_central_brain.sql. Every field documented
 * here is a column in brain_documents / brain_chunks / brain_jobs — keep
 * the schema and this file in sync.
 */

export type BrainKind =
  | "pdf"
  | "docx"
  | "text"
  | "markdown"
  | "csv"
  | "html"
  | "audio"
  | "video"
  | "image"
  | "email"
  | "other";

export type BrainStatus =
  | "queued"
  | "extracting"
  | "chunking"
  | "embedding"
  | "indexed"
  | "failed"
  | "skipped";

export type BrainJobType = "extract" | "chunk" | "embed" | "transcribe" | "ocr";
export type BrainJobStatus = "queued" | "running" | "succeeded" | "failed" | "skipped";

/** Full row from brain_documents. Index signature satisfies the pg
 *  query helper's generic constraint (T extends Record<string, unknown>). */
export interface BrainDocument {
  id: string;
  ms_drive_item_id: string | null;
  ms_file_local_id: string | null;
  web_url: string | null;
  filename: string;
  content_type: string;
  size_bytes: number;
  sha256: string;
  kind: BrainKind;
  status: BrainStatus;
  status_detail: string | null;
  extracted_chars: number;
  chunk_count: number;
  tokens_used: number;
  uploaded_by: string;
  uploader_role: string;
  tags: string[];
  created_at: string;
  updated_at: string;
  indexed_at: string | null;
  [key: string]: unknown;
}

/** Full row from brain_chunks. */
export interface BrainChunk {
  id: string;
  document_id: string;
  chunk_idx: number;
  content: string;
  token_estimate: number;
  qdrant_point_id: string | null;
  embedded: boolean;
  created_at: string;
  [key: string]: unknown;
}

/** A ranked retrieval hit returned by query(). */
export interface BrainQueryHit {
  chunk_id: string;
  document_id: string;
  document_filename: string;
  document_kind: BrainKind;
  chunk_idx: number;
  content: string;
  score: number;
  source: "keyword" | "semantic" | "keyword+semantic";
  snippet: string; // highlighted substring for UI
}

export interface BrainQueryResult {
  query: string;
  hits: BrainQueryHit[];
  keyword_hits: number;
  semantic_hits: number;
  latency_ms: number;
  tokens_used: number;
}

/** Parameters a caller passes to ingest(). */
export interface IngestRequest {
  filename: string;
  contentType: string;
  buffer: Buffer;
  uploadedBy: string;
  uploaderRole: string;
  tags?: string[];
  /** OneDrive parent folder id when we also want to mirror to Graph. */
  onedriveParentId?: string;
  /** Source URL where this document can be opened (SharePoint webUrl,
   *  Stream Watch URL, etc.). Stored on brain_documents.web_url so
   *  chat citations can render as clickable links to the original. */
  webUrl?: string;
}

export interface IngestResult {
  document_id: string;
  status: BrainStatus;
  chunk_count: number;
  extracted_chars: number;
  duplicate_of?: string; // set when sha256 matched an existing row
}

/**
 * A single semantic unit produced by the chunker. Token count is an
 * estimate, not a tokenizer pass — fine for retrieval-budget math.
 */
export interface TextChunk {
  idx: number;
  content: string;
  token_estimate: number;
}

/** MIME → kind discriminator. Matches brain_documents.kind CHECK. */
export function classifyKind(contentType: string, filename: string): BrainKind {
  const ct = (contentType || "").toLowerCase();
  const fn = filename.toLowerCase();
  if (ct === "application/pdf" || fn.endsWith(".pdf")) return "pdf";
  if (
    ct === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    fn.endsWith(".docx")
  ) {
    return "docx";
  }
  if (ct === "text/csv" || fn.endsWith(".csv")) return "csv";
  if (ct === "text/markdown" || fn.endsWith(".md") || fn.endsWith(".markdown")) return "markdown";
  if (ct === "text/html" || fn.endsWith(".html") || fn.endsWith(".htm")) return "html";
  /* JSON is text — the upload-filter advertises it as supported but
     pre-fix classifyKind dropped to "other" → ingest set status to
     "skipped" → row in DB but invisible/unsearchable. Treat as text
     so the existing text extractor handles it; the raw JSON body
     is what we want to embed for retrieval anyway. */
  if (ct === "application/json" || fn.endsWith(".json")) return "text";
  if (ct.startsWith("text/") || fn.endsWith(".txt")) return "text";
  if (ct.startsWith("audio/")) return "audio";
  if (ct.startsWith("video/")) return "video";
  if (ct.startsWith("image/")) return "image";
  if (ct === "message/rfc822" || fn.endsWith(".eml") || fn.endsWith(".mbox")) return "email";
  return "other";
}
