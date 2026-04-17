/**
 * Text extraction — dispatches per file kind.
 *
 * Every extractor returns either {ok, text, pages?} or {ok: false, reason}.
 * Callers MUST branch on `.ok`; throwing from here would break the
 * triple-write orchestration in ingest.ts, which relies on typed results
 * (per .ai/conventions.md: integrations return Result, never throw).
 *
 * Pure-JS dependencies only — everything here must run on a Vercel
 * Function without native modules: `unpdf` (already in package.json) and
 * `mammoth`. Audio/video/image extraction is pointed at async Whisper /
 * OCR workers in v0.2 via brain_jobs; this v0.1 path returns a
 * "skipped" result so the document still indexes its metadata but the
 * status reflects reality.
 */

import { classifyKind, type BrainKind } from "./types";

export type ExtractSuccess = {
  ok: true;
  text: string;
  pages?: number;
  detail?: string;
};
export type ExtractSkipped = {
  ok: false;
  reason: "unsupported" | "empty" | "deferred";
  detail?: string;
};
export type ExtractFailed = {
  ok: false;
  reason: "failed";
  detail: string;
};
export type ExtractResult = ExtractSuccess | ExtractSkipped | ExtractFailed;

/**
 * The kinds that have a synchronous, in-process extractor today.
 * Audio/video/image/email still land durable rows in Postgres + OneDrive;
 * their extraction is deferred to a worker (queued via brain_jobs) and
 * the document sits in `status = 'skipped'` meanwhile so it's visible
 * in the UI with a clear label instead of silently failing.
 */
const SYNC_KINDS: ReadonlySet<BrainKind> = new Set(["pdf", "docx", "text", "markdown", "csv", "html"]);

export function isSyncExtractable(kind: BrainKind): boolean {
  return SYNC_KINDS.has(kind);
}

export async function extract(
  kind: BrainKind,
  buffer: Buffer,
): Promise<ExtractResult> {
  try {
    switch (kind) {
      case "pdf":
        return await extractPdf(buffer);
      case "docx":
        return await extractDocx(buffer);
      case "text":
      case "markdown":
        return extractText(buffer);
      case "csv":
        return extractCsv(buffer);
      case "html":
        return extractHtml(buffer);
      case "audio":
      case "video":
      case "image":
      case "email":
        return { ok: false, reason: "deferred", detail: `${kind} extraction queued for worker` };
      default:
        return { ok: false, reason: "unsupported", detail: `no extractor for kind=${kind}` };
    }
  } catch (err) {
    return {
      ok: false,
      reason: "failed",
      detail: (err as Error).message ?? "extract threw",
    };
  }
}

// ── PDF ──────────────────────────────────────────────────────────

async function extractPdf(buffer: Buffer): Promise<ExtractResult> {
  const { extractText: unpdfExtract } = await import("unpdf");
  const { text, totalPages } = await unpdfExtract(new Uint8Array(buffer), { mergePages: true });
  const joined = Array.isArray(text) ? text.join("\n\n") : text;
  if (!joined || !joined.trim()) {
    return { ok: false, reason: "empty", detail: "PDF contained no extractable text (scanned?)" };
  }
  return { ok: true, text: joined, pages: totalPages };
}

// ── DOCX ─────────────────────────────────────────────────────────

async function extractDocx(buffer: Buffer): Promise<ExtractResult> {
  // Dynamic import so mammoth only loads on the routes that need it
  const mammoth = await import("mammoth");
  const result = await mammoth.extractRawText({ buffer });
  const text = (result.value || "").trim();
  if (!text) {
    return { ok: false, reason: "empty", detail: "DOCX had no extractable text" };
  }
  const detail = result.messages && result.messages.length > 0
    ? `mammoth notes: ${result.messages.length}`
    : undefined;
  return { ok: true, text, detail };
}

// ── Plain text / markdown ────────────────────────────────────────

function extractText(buffer: Buffer): ExtractResult {
  const text = buffer.toString("utf-8").trim();
  if (!text) return { ok: false, reason: "empty", detail: "empty file" };
  return { ok: true, text };
}

// ── CSV ──────────────────────────────────────────────────────────

function extractCsv(buffer: Buffer): ExtractResult {
  const raw = buffer.toString("utf-8");
  if (!raw.trim()) return { ok: false, reason: "empty", detail: "empty CSV" };
  // Keep structure for retrieval — each row stays on its own line, but
  // we surface a simple header block at the top so keyword search finds
  // column names first. Proper CSV parsing (RFC 4180 quoting) lands when
  // we import a dependency; v0.1 uses a tolerant naive split because
  // every major spreadsheet app exports CSV without embedded commas for
  // the header row.
  const firstLine = raw.split(/\r?\n/, 1)[0] || "";
  const headers = firstLine.split(",").map((h) => h.trim());
  const headerBlock = headers.length > 1 ? `Columns: ${headers.join(" | ")}\n\n` : "";
  return { ok: true, text: headerBlock + raw.trim() };
}

// ── HTML ─────────────────────────────────────────────────────────

function extractHtml(buffer: Buffer): ExtractResult {
  // Very simple HTML → text. Strip <script> and <style> blocks, then all
  // other tags. Keeps line breaks on block-level tags so paragraphs
  // survive. Not a full parser; a full parser (cheerio) is too much
  // weight for v0.1 and the retrieval layer tolerates noise fine.
  const raw = buffer.toString("utf-8");
  if (!raw.trim()) return { ok: false, reason: "empty", detail: "empty HTML" };
  const stripped = raw
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/?(p|div|br|h[1-6]|li|tr|section|article)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .trim();
  if (!stripped) return { ok: false, reason: "empty", detail: "HTML had no text nodes" };
  return { ok: true, text: stripped };
}

// Re-export for route handlers that want to dispatch by MIME in one call
export { classifyKind };
