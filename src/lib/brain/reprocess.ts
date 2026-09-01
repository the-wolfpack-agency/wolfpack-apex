/**
 * Re-run extraction on documents that failed for a reason since fixed.
 *
 * WHY THIS EXISTS, and it is the third instance of one pattern this week.
 * Ninety Word documents, which is EVERY .docx in the Brain, sat at
 * status=failed with `DOMParser.parseFromString: mimeType "undefined"`. The
 * parser was fixed on 2026-08-25 in #402, whose own commit message names those
 * ninety documents. They were last touched on 2026-06-10 and are still failed.
 * The fix shipped and the corpus it was written for was never re-run.
 *
 * That is the same shape as a control declared, described accurately and never
 * executed. A fix that does not reach the rows it was written for has not
 * happened, whatever the diff says.
 *
 * WHY NOT ingest(). ingest() dedupes on the sha256 and returns the EXISTING
 * row, so calling it again on a failed document hands back the failure. That
 * is correct for an upload and useless for a repair, so this re-extracts in
 * place: same document id, same web_url, same citations, new chunks.
 *
 * WHY IT RECLASSIFIES. Twenty-seven files named .xlsx are stored as kind
 * "other" and were skipped for want of an extractor that has existed all
 * along. Trusting the stored kind would preserve the misclassification
 * forever, so the kind is recomputed from the filename and content type.
 *
 * NEEDS GRAPH CREDENTIALS. The bytes are not kept: the Brain stores text and
 * chunks, not the original file. So a repair has to re-download from the drive
 * and can only run where the Microsoft credentials are, which on this
 * deployment is production. Hence the admin route rather than a local script.
 */

import { trackEvent } from "@/lib/analytics";
import { capExtracted } from "./security";
import { chunkText } from "./chunker";
import { classifyKind, extract, isSyncExtractable } from "./extractor";
import { decideOcrRoute, withinOcrBudget } from "./ocr-policy";
import { ocrImage, isVisionConfigured } from "@/lib/azure/vision-ocr";
import { embedBatch, isEmbeddingConfigured } from "./embedder";
import { upsertBrainPoints, deleteByDocumentId } from "./qdrant";
import {
  deleteChunksForDocument,
  insertChunks,
  markChunksEmbedded,
  recordJob,
  updateDocumentStats,
  updateDocumentStatus,
} from "./repo";
import { query } from "@/lib/db";
import type { BrainDocument } from "./types";

/**
 * Failure reasons that are worth retrying, and the reason each is fixable.
 *
 * AN ALLOWLIST, NOT A BLANKET RETRY. Retrying everything would re-download
 * sixty-two genuinely scanned PDFs on every run, spend the bandwidth and end
 * in the same state, which teaches whoever reads the report to ignore it. A
 * document only becomes a candidate when somebody has actually fixed the thing
 * that broke it.
 */
export const FIXABLE: Array<{ id: string; test: RegExp; source: string; why: string }> = [
  {
    id: "docx_mimetype",
    test: /DOMParser|mimeType|docx parse/i,
    /* The same pattern in a form Postgres understands, kept beside the RegExp
       so the two cannot describe different sets of documents. Plain
       alternation only: anything needing JS-specific syntax would have to be
       expressed for both engines and checked, and a repair that quietly
       matched different rows in the planner and the repairer is the bug this
       whole change is about. */
    source: "DOMParser|mimeType|docx parse",
    why: "the xmldom 0.9 mimeType break, fixed in #402 by moving off mammoth",
  },
  {
    id: "extractor_now_exists",
    test: /sync extractor unavailable/i,
    source: "sync extractor unavailable",
    why: "classified as a kind with no extractor, often a misclassified xlsx or docx",
  },
];

/** What one document's OCR may cost before the repair refuses it. */
export const OCR_CEILING_CENTS = 25;

/** Non-terminal states. A document here is mid-flight or abandoned. */
export const NON_TERMINAL = ["queued", "extracting", "chunking", "embedding"] as const;

export interface ReprocessCandidate {
  id: string;
  filename: string;
  kind: string;
  status: string;
  statusDetail: string | null;
  driveItemId: string | null;
  reason: string;
}

export interface ReprocessOutcome {
  id: string;
  filename: string;
  before: string;
  after: string;
  chunks: number;
  detail: string | null;
}

export interface ReprocessReport {
  considered: number;
  attempted: number;
  repaired: number;
  stillFailing: number;
  skippedNoDriveItem: number;
  outcomes: ReprocessOutcome[];
}

/**
 * Documents worth retrying: a fixable failure, or stranded in a non-terminal
 * state for longer than any real job takes.
 */
export async function findCandidates(
  opts: { limit?: number; strandedMinutes?: number } = {},
): Promise<ReprocessCandidate[]> {
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000);
  const stranded = opts.strandedMinutes ?? 60;

  /* LIMIT is a bound parameter, not an interpolation. It is already clamped
     above, but the repo-wide guard is right that a clamped value today is an
     unclamped one after the next edit. */
  /* ONLY ROWS THAT CAN ACTUALLY BE REPAIRED.
   *
   * The Brain stores text and chunks, never the original bytes, so a repair
   * has to re-download the file from its drive. Measured on 2026-08-27: NONE
   * of the 332 failed or skipped documents has an ms_drive_item_id. They are
   * demo fixtures and hand uploads, and there is nowhere to fetch them from.
   *
   * Without this predicate the run would walk all 332, fail to fetch every
   * one, and rewrite each row's status to failed with a new detail string:
   * 332 pointless writes, a status change for the 167 that were merely
   * skipped, and a report that reads like work happened. Selecting only what
   * is repairable means an empty candidate list is the honest answer. */
  /* FIXABILITY IS DECIDED IN SQL, NOT AFTER THE LIMIT.
   *
   * It used to select the newest N rows and then discard the ones nothing can
   * fix, which made `limit` mean "rows to look at" while every caller read it
   * as "documents to repair". The two are wildly different when the newest
   * rows are the unfixable ones.
   *
   * Measured 2026-09-01, with 186 repairable documents waiting:
   *
   *     limit  50  ->    0 candidates     <- what the nightly job sends
   *     limit 100  ->   49
   *     limit 200  ->   98                <- what the plan step reports
   *     limit 500  ->  186
   *
   * So the sweep logged "186 documents waiting on a repair" and then "repaired
   * 0, still failing 0" every night, and exited green, because its two steps
   * asked the same question with different limits and got different answers.
   * Ninety Word documents of the client's course material sat unreadable
   * behind a job that reported success.
   *
   * The patterns come from FIXABLE rather than being restated here, so the
   * planner and the repairer cannot drift about what "fixable" means. */
  const fixablePatterns = FIXABLE.map((f) => f.source);
  const { rows } = await query<BrainDocument>(
    `SELECT * FROM brain_documents
      WHERE ms_drive_item_id IS NOT NULL
        AND (
          (status IN ('failed','skipped') AND status_detail ~* ANY($1::text[]))
          OR (status = ANY($2::text[]) AND updated_at < NOW() - ($3::int * INTERVAL '1 minute'))
        )
      ORDER BY created_at DESC
      LIMIT $4`,
    [fixablePatterns, NON_TERMINAL as unknown as string[], stranded, limit],
  );

  const out: ReprocessCandidate[] = [];
  for (const d of rows) {
    const detail = d.status_detail ?? "";
    const strandedRow = (NON_TERMINAL as readonly string[]).includes(d.status);
    const match = FIXABLE.find((f) => f.test.test(detail));
    if (!strandedRow && !match) continue;
    out.push({
      id: d.id,
      filename: d.filename,
      kind: d.kind,
      status: d.status,
      statusDetail: d.status_detail,
      driveItemId: d.ms_drive_item_id,
      reason: strandedRow ? `stranded in ${d.status}` : match!.id,
    });
  }
  return out;
}

/** Fetch the original bytes. Injected so the reader is testable without Graph. */
export type FetchBytes = (driveItemId: string) => Promise<Buffer | null>;

/**
 * Re-extract one document in place.
 *
 * Every exit updates the row. A repair that leaves a document in the state it
 * was already in, silently, is how ten PDFs came to sit in "chunking" since
 * May with nothing noticing.
 */
async function reprocessOne(
  doc: ReprocessCandidate,
  fetchBytes: FetchBytes,
  actor: { userId: string; role: string },
): Promise<ReprocessOutcome> {
  const started = Date.now();
  const fail = (after: string, detail: string): ReprocessOutcome => ({
    id: doc.id,
    filename: doc.filename,
    before: doc.status,
    after,
    chunks: 0,
    detail,
  });

  if (!doc.driveItemId) {
    /* Uploaded directly rather than synced: there is nowhere to re-fetch from,
       and saying so is better than retrying it on every run forever. */
    await updateDocumentStatus(doc.id, "failed", "no drive item to re-fetch; re-upload to repair");
    return fail("failed", "no drive item to re-fetch");
  }

  /* A FETCH THAT FAILED SAYS NOTHING ABOUT THE DOCUMENT.
   *
   * This used to overwrite status_detail with the fetch error, which erased
   * the diagnosis that made the document repairable in the first place. Since
   * a fetch error is not in FIXABLE, the document then dropped out of the
   * candidate set and no later run would ever look at it again.
   *
   * Measured 2026-09-01. Every Microsoft token expired on 2026-08-26, so a run
   * took 50 documents, failed to download all 50, and rewrote every one from
   * "docx mimeType" to "re-fetch failed: no_token". The fixable queue went
   * from 186 to 136 and the no_token pile grew from 37 to 87. The repair was
   * destroying its own work queue, one batch per night, and reporting success.
   *
   * A transient failure leaves the row exactly as it found it. The outcome is
   * still returned, so the run reports what happened; what it must not do is
   * launder an outage into a permanent verdict about a file it never read. */
  let buffer: Buffer | null;
  try {
    buffer = await fetchBytes(doc.driveItemId);
  } catch (err) {
    return fail("failed", `re-fetch failed: ${(err as Error).message}`);
  }
  if (!buffer || buffer.length === 0) {
    return fail("failed", "re-fetch returned no bytes");
  }

  /* RECLASSIFY. The stored kind is what a previous classifier decided, and for
     twenty-seven .xlsx files it decided "other" and skipped them. */
  const kind = classifyKind(undefined as never, doc.filename);
  if (!isSyncExtractable(kind)) {
    await updateDocumentStatus(doc.id, "skipped", `no sync extractor for ${kind}`);
    return fail("skipped", `no sync extractor for ${kind}`);
  }

  await updateDocumentStatus(doc.id, "extracting");
  let extracted = await extract(kind, buffer);

  /* NO TEXT IN A SCAN IS NOT A BROKEN PARSE. Sixty-two PDFs and forty-three
     images are in the library with nothing to quote because the page is a
     picture. The policy decides whether reading it is worth what it costs, and
     picks the cheap purpose-built route before the vision model, which is one
     to two orders of magnitude dearer per page. It is asked here, on the real
     path, rather than being a module only its own test ever calls. */
  if (!extracted.ok) {
    const decision = decideOcrRoute(
      { kind, failureDetail: extracted.detail ?? null },
      { visionApi: isVisionConfigured(), visionModel: false },
    );
    const budget = withinOcrBudget({ pages: 1, decision, ceilingCents: OCR_CEILING_CENTS });

    if (decision.route === "vision_api" && budget.allowed) {
      const ocr = await ocrImage(buffer, {
        triggeredBy: actor.userId,
        triggeredByRole: actor.role,
        documentId: doc.id,
      });
      if (ocr.ok && ocr.text.trim()) {
        extracted = { ok: true, text: ocr.text };
        trackEvent("brain.document_ocred", actor.userId, actor.role, {
          document_id: doc.id,
          kind,
          route: decision.route,
          estimated_cents: budget.estimatedCents ?? "unknown",
          chars: ocr.text.length,
        });
      } else {
        /* The reason is kept verbatim so a later run can tell a page the OCR
           API refused (escalatable) from one it could not physically read. */
        const why = ocr.ok ? "OCR returned no text" : `${ocr.reason}: ${ocr.detail ?? ""}`;
        await updateDocumentStatus(doc.id, "failed", `ocr ${why}`);
        return fail("failed", `ocr ${why}`);
      }
    }
  }

  if (!extracted.ok) {
    await updateDocumentStatus(doc.id, "failed", extracted.detail ?? "extraction failed");
    await recordJob(doc.id, "extract", "failed", {
      error: extracted.detail ?? undefined,
      durationMs: Date.now() - started,
    });
    return fail("failed", extracted.detail ?? "extraction failed");
  }

  const capped = capExtracted(extracted.text);
  await updateDocumentStatus(doc.id, "chunking");

  /* Old chunks go first, and so do old vectors. A repair that appends leaves
     the document quoted twice, once from the broken extraction. */
  await deleteChunksForDocument(doc.id);
  await deleteByDocumentId(doc.id).catch(() => undefined);

  const chunks = chunkText(capped.text);
  if (chunks.length === 0) {
    await updateDocumentStatus(doc.id, "indexed", "document had text but produced no chunks");
    await updateDocumentStats(doc.id, capped.text.length, 0, 0);
    return { id: doc.id, filename: doc.filename, before: doc.status, after: "indexed", chunks: 0, detail: "no chunks" };
  }

  const inserted = await insertChunks(
    doc.id,
    chunks.map((c, i) => ({ idx: i, content: c.content, tokenEstimate: c.token_estimate })),
  );

  let tokensUsed = 0;
  if (isEmbeddingConfigured()) {
    await updateDocumentStatus(doc.id, "embedding");
    try {
      const result = await embedBatch(inserted.map((c) => c.content));
      if (result && result.vectors.length === inserted.length) {
        tokensUsed = result.tokensUsed;
        await upsertBrainPoints(
          inserted.map((c, i) => ({
            id: c.id,
            vector: result.vectors[i],
            payload: { document_id: doc.id, chunk_id: c.id, chunk_idx: c.chunk_idx },
          })) as never,
        );
        await markChunksEmbedded(inserted.map((c) => c.id), inserted.map((c) => c.id));
      }
    } catch {
      /* Keyword search works without vectors, so a dead embedder must not undo
         a repair that already recovered the text. */
    }
  }

  await updateDocumentStats(doc.id, capped.text.length, inserted.length, tokensUsed);
  await updateDocumentStatus(doc.id, "indexed", null);
  await recordJob(doc.id, "extract", "succeeded", { durationMs: Date.now() - started });

  trackEvent("brain.document_reprocessed", actor.userId, actor.role, {
    document_id: doc.id,
    kind,
    reason: doc.reason,
    before: doc.status,
    chunks: inserted.length,
  });

  return {
    id: doc.id,
    filename: doc.filename,
    before: doc.status,
    after: "indexed",
    chunks: inserted.length,
    detail: null,
  };
}

/**
 * Repair every candidate, one at a time.
 *
 * SERIAL ON PURPOSE. Each item downloads a file from Graph, and Graph throttles
 * a burst hard enough that a parallel run would spend the repair budget on 429s.
 */
export async function reprocessFixable(
  fetchBytes: FetchBytes,
  actor: { userId: string; role: string },
  opts: { limit?: number; strandedMinutes?: number } = {},
): Promise<ReprocessReport> {
  const candidates = await findCandidates(opts);
  const outcomes: ReprocessOutcome[] = [];
  let skippedNoDriveItem = 0;

  for (const c of candidates) {
    if (!c.driveItemId) skippedNoDriveItem += 1;
    outcomes.push(await reprocessOne(c, fetchBytes, actor));
  }

  const repaired = outcomes.filter((o) => o.after === "indexed" && o.chunks > 0).length;
  const report: ReprocessReport = {
    considered: candidates.length,
    attempted: outcomes.length,
    repaired,
    stillFailing: outcomes.length - repaired,
    skippedNoDriveItem,
    outcomes,
  };

  trackEvent("brain.reprocess_run", actor.userId, actor.role, {
    considered: report.considered,
    repaired: report.repaired,
    still_failing: report.stillFailing,
  });

  return report;
}
