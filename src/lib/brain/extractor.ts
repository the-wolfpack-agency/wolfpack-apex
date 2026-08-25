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
import { htmlToText } from "@/lib/html-sanitize";
import { ocrImage, isVisionConfigured } from "@/lib/azure/vision-ocr";

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
const SYNC_KINDS: ReadonlySet<BrainKind> = new Set(["pdf", "docx", "xlsx", "text", "markdown", "csv", "html"]);

export function isSyncExtractable(kind: BrainKind): boolean {
  if (SYNC_KINDS.has(kind)) return true;
  /* image extraction is sync-extractable iff Azure Computer Vision is
     configured. When credentials aren't set, fall through to the
     legacy 'deferred' path so behavior is unchanged from before the
     Vision integration. */
  if (kind === "image" && isVisionConfigured()) return true;
  return false;
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
      case "xlsx":
        return extractXlsx(buffer);
      case "text":
      case "markdown":
        return extractText(buffer);
      case "csv":
        return extractCsv(buffer);
      case "html":
        return extractHtml(buffer);
      case "image":
        /* Sync image OCR via Azure Computer Vision when configured.
           Falls back to the deferred-worker label otherwise so the
           document still indexes its metadata. */
        if (isVisionConfigured()) return await extractImage(buffer);
        return { ok: false, reason: "deferred", detail: "image extraction queued for worker" };
      case "audio":
      case "video":
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

// ── Image (Azure Computer Vision READ) ───────────────────────────

/**
 * OCR an image buffer via Azure Computer Vision. Triggered for any
 * brain ingest where classifyKind returns "image" AND Vision is
 * configured. The audit trail (instinct_azure_calls) is written
 * inside ocrImage so this branch stays focused on mapping the result
 * to the ExtractResult union.
 *
 * NOTE: `triggeredBy` is unavailable here because the extractor is
 * called from a generic pipeline; we pass null so the audit row marks
 * it as a system call. To attribute calls to specific users, plumb
 * the user id through ingest() → extract() as a follow-up.
 */
async function extractImage(buffer: Buffer): Promise<ExtractResult> {
  const res = await ocrImage(buffer, {
    triggeredBy: null,
    triggeredByRole: null,
    contentType: "application/octet-stream",
  });
  if (!res.ok) {
    return {
      ok: false,
      reason: res.reason === "rate_limited" || res.reason === "polling_timeout" || res.reason === "unavailable" ? "deferred" : "failed",
      detail: `vision: ${res.reason} — ${res.detail}`,
    };
  }
  if (res.emptyImage || !res.text.trim()) {
    return { ok: false, reason: "empty", detail: "image contained no recognizable text" };
  }
  return { ok: true, text: res.text, pages: res.pages };
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

/**
 * .docx text, without mammoth.
 *
 * THE THIRD PLACE THIS BUG HAS BEEN FIXED, and the one that mattered most.
 *
 * package.json overrides @xmldom/xmldom to 0.9.x to clear a high-severity
 * advisory in the 0.8 line. mammoth declares ^0.8.6 and every published
 * version still does, including the latest. 0.9 made the mimeType argument
 * required, and mammoth's own wrapper (lib/xml/xmldom.js) takes only the
 * string, dropping the "text/xml" its caller passes at lib/xml/reader.js. So
 * every call arrives with mimeType undefined and throws.
 *
 * src/lib/principles/parser.ts hit this and moved to a dependency-free
 * extractor. The meeting-insights attachment extractor hit it and adopted the
 * same one. The Brain, which is where a corporate document library actually
 * lands, was never changed: 90 Word documents in production failed with
 * `DOMParser.parseFromString: the provided mimeType "undefined" is not valid`,
 * and docx is most of what such a library is made of.
 *
 * Reusing docxBufferToMarkdown rather than writing a fourth version, and
 * rather than patching mammoth's call sites at runtime: the patch would have
 * been two deep, because mammoth also passes an errorHandler that 0.9
 * deprecated and then treats the deprecation warning as a parse failure.
 *
 * Markdown is the right output here. Heading and emphasis markers cost a few
 * characters per chunk and carry document structure into the embedding, which
 * is worth more to retrieval than it costs.
 */
async function extractDocx(buffer: Buffer): Promise<ExtractResult> {
  const { docxBufferToMarkdown } = await import("@/lib/principles/parser");
  let text: string;
  try {
    text = (await docxBufferToMarkdown(buffer)).trim();
  } catch (err) {
    return { ok: false, reason: "failed", detail: `docx parse: ${(err as Error).message}` };
  }
  if (!text) {
    return { ok: false, reason: "empty", detail: "DOCX had no extractable text" };
  }
  return { ok: true, text };
}

// ── Plain text / markdown ────────────────────────────────────────

function extractText(buffer: Buffer): ExtractResult {
  const text = buffer.toString("utf-8").trim();
  if (!text) return { ok: false, reason: "empty", detail: "empty file" };
  return { ok: true, text };
}

// ── XLSX ─────────────────────────────────────────────────────────

/**
 * xlsx via SheetJS (dependency already in package.json). Renders every
 * sheet as CSV-shaped plaintext so the same chunker / embeddings path
 * the rest of the brain uses applies. Each sheet gets a "Sheet: <name>"
 * header so retrieval can surface "Job Codes" vs "Notes" vs whatever
 * tabs exist. Empty sheets are dropped.
 */
function extractXlsx(buffer: Buffer): ExtractResult {
  /* Lazy require to keep the module-load cost off the cold path for
     callers that never touch xlsx. */
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const XLSX = require("xlsx") as typeof import("xlsx");
  let workbook: import("xlsx").WorkBook;
  try {
    workbook = XLSX.read(buffer, { type: "buffer" });
  } catch (err) {
    return { ok: false, reason: "failed", detail: `xlsx parse: ${(err as Error).message}` };
  }
  if (!workbook.SheetNames || workbook.SheetNames.length === 0) {
    return { ok: false, reason: "empty", detail: "xlsx has no sheets" };
  }
  const parts: string[] = [];
  for (const name of workbook.SheetNames) {
    const sheet = workbook.Sheets[name];
    if (!sheet) continue;
    const csv = XLSX.utils.sheet_to_csv(sheet).trim();
    if (!csv) continue;
    parts.push(`Sheet: ${name}\n${csv}`);
  }
  if (parts.length === 0) {
    return { ok: false, reason: "empty", detail: "xlsx has no non-empty sheets" };
  }
  return { ok: true, text: parts.join("\n\n---\n\n") };
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
  // Parser-based HTML→text via @/lib/html-sanitize. The previous
  // regex-based strip was flagged by CodeQL for js/bad-tag-filter; a
  // single-pass parser blocks the `<scr<script>ipt>` mutation class.
  const raw = buffer.toString("utf-8");
  if (!raw.trim()) return { ok: false, reason: "empty", detail: "empty HTML" };
  const stripped = htmlToText(raw)
    .replace(/\s+\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .trim();
  if (!stripped) return { ok: false, reason: "empty", detail: "HTML had no text nodes" };
  return { ok: true, text: stripped };
}

// Re-export for route handlers that want to dispatch by MIME in one call
export { classifyKind };
