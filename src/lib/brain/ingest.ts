/**
 * Ingest orchestrator — the single entrypoint for adding a file to the
 * Central Brain. Route handlers hand us bytes; this module owns the
 * lifecycle: dedupe → extract → chunk → embed → index → audit.
 *
 * Contract guarantees:
 *   - A brain_documents row always exists after ingest returns, even on
 *     extraction failure (status="failed"). No silent drops.
 *   - Every content-hash duplicate returns the existing document_id with
 *     duplicate_of set. Re-upload is a no-op.
 *   - Qdrant + embedding failures never fail the ingest — the doc ends
 *     `status='indexed'` with keyword-only retrieval (embedded=false on
 *     chunks). A later reconciler can back-fill embeddings.
 *   - Every job step records a brain_jobs row with duration + outcome
 *     so the UI and analytics pipeline see the full history.
 */

import { trackEvent } from "@/lib/analytics";
import { randomUUID } from "node:crypto";
import { classifyKind, extract, isSyncExtractable } from "./extractor";
import { chunkText } from "./chunker";
import { embedBatch, isEmbeddingConfigured } from "./embedder";
import { upsertBrainPoints } from "./qdrant";
import {
  createDocument,
  findDocumentBySha,
  insertChunks,
  markChunksEmbedded,
  recordJob,
  sha256,
  updateDocumentStats,
  updateDocumentStatus,
} from "./repo";
import { capExtracted } from "./security";
import type { IngestRequest, IngestResult } from "./types";

const MAX_SIZE_BYTES = Number(process.env.BRAIN_MAX_SIZE_BYTES ?? 50 * 1024 * 1024); // 50 MB default
const ALLOWED_EMPTY = new Set(["audio", "video", "image"]); // fine to land with no extracted text

export async function ingest(req: IngestRequest): Promise<IngestResult> {
  // 1. validate
  if (!req.buffer || req.buffer.length === 0) {
    throw new BrainIngestError("empty_file", "uploaded file is empty");
  }
  if (req.buffer.length > MAX_SIZE_BYTES) {
    throw new BrainIngestError(
      "too_large",
      `file exceeds ${MAX_SIZE_BYTES} bytes (got ${req.buffer.length})`,
    );
  }

  const kind = classifyKind(req.contentType, req.filename);
  const digest = sha256(req.buffer);

  await trackEvent("brain.upload_started", req.uploadedBy, req.uploaderRole, {
    filename: req.filename,
    kind,
    content_type: req.contentType,
    size_bytes: req.buffer.length,
  });

  // 2. dedupe
  const existing = await findDocumentBySha(digest);
  if (existing) {
    return {
      document_id: existing.id,
      status: existing.status,
      chunk_count: existing.chunk_count,
      extracted_chars: existing.extracted_chars,
      duplicate_of: existing.id,
    };
  }

  // 3. durable row (status=queued). Everything after this is recoverable
  //    because Postgres has the seed.
  const doc = await createDocument({
    filename: req.filename,
    contentType: req.contentType,
    sizeBytes: req.buffer.length,
    sha256: digest,
    kind,
    uploadedBy: req.uploadedBy,
    uploaderRole: req.uploaderRole,
    tags: req.tags,
    webUrl: req.webUrl,
  });

  // 4. extraction
  await updateDocumentStatus(doc.id, "extracting");
  const t0 = Date.now();

  if (!isSyncExtractable(kind)) {
    // Still durable; worker handles it later. Mark as 'skipped' so UI
    // shows an honest "awaiting transcription / OCR" label.
    await recordJob(doc.id, "extract", "skipped", {
      durationMs: Date.now() - t0,
      error: `no sync extractor for kind=${kind}`,
    });
    await updateDocumentStatus(doc.id, "skipped", `sync extractor unavailable for ${kind}`);
    await trackEvent("brain.extraction_failed", req.uploadedBy, req.uploaderRole, {
      document_id: doc.id,
      kind,
      reason: "deferred",
    });
    return {
      document_id: doc.id,
      status: "skipped",
      chunk_count: 0,
      extracted_chars: 0,
    };
  }

  const extracted = await extract(kind, req.buffer);
  if (!extracted.ok) {
    const isEmpty = extracted.reason === "empty" && ALLOWED_EMPTY.has(kind);
    const finalStatus = isEmpty ? "skipped" : "failed";
    await recordJob(doc.id, "extract", "failed", {
      durationMs: Date.now() - t0,
      error: extracted.detail,
    });
    await updateDocumentStatus(doc.id, finalStatus, extracted.detail);
    await trackEvent("brain.extraction_failed", req.uploadedBy, req.uploaderRole, {
      document_id: doc.id,
      kind,
      reason: extracted.reason,
    });
    return {
      document_id: doc.id,
      status: finalStatus,
      chunk_count: 0,
      extracted_chars: 0,
    };
  }

  await recordJob(doc.id, "extract", "succeeded", { durationMs: Date.now() - t0 });

  // DoS guard: a 1KB "PDF bomb" can expand to GB of text. Cap the
  // extracted plaintext before chunking so a runaway doc can never
  // exhaust memory or blow the DB row-size limit. When truncated, we
  // stamp status_detail so the UI shows "indexed · truncated" rather
  // than claiming full coverage.
  const capped = capExtracted(extracted.text);
  if (capped.truncated) {
    await trackEvent("brain.extraction_succeeded", req.uploadedBy, req.uploaderRole, {
      document_id: doc.id,
      kind,
      chars: capped.text.length,
      truncated: true,
      original_chars: capped.originalLength,
    });
  } else {
    await trackEvent("brain.extraction_succeeded", req.uploadedBy, req.uploaderRole, {
      document_id: doc.id,
      kind,
      chars: extracted.text.length,
    });
  }

  // 5. chunk
  await updateDocumentStatus(
    doc.id,
    "chunking",
    capped.truncated
      ? `extraction truncated at ${capped.text.length} chars (original ${capped.originalLength})`
      : undefined,
  );
  const tChunk = Date.now();
  const chunks = chunkText(capped.text);
  if (chunks.length === 0) {
    await recordJob(doc.id, "chunk", "skipped", { durationMs: Date.now() - tChunk });
    await updateDocumentStatus(doc.id, "indexed", "document had text but produced no chunks");
    await updateDocumentStats(doc.id, capped.text.length, 0, 0);
    return {
      document_id: doc.id,
      status: "indexed",
      chunk_count: 0,
      extracted_chars: capped.text.length,
    };
  }

  const inserted = await insertChunks(
    doc.id,
    chunks.map((c) => ({
      idx: c.idx,
      content: c.content,
      tokenEstimate: c.token_estimate,
    })),
  );
  await recordJob(doc.id, "chunk", "succeeded", { durationMs: Date.now() - tChunk });
  await trackEvent("brain.chunked", req.uploadedBy, req.uploaderRole, {
    document_id: doc.id,
    chunk_count: inserted.length,
  });

  // 6. embed (best-effort). Skip entirely when no key configured — chunks
  //    still retrievable via Postgres FTS.
  let tokensUsed = 0;
  if (isEmbeddingConfigured()) {
    await updateDocumentStatus(doc.id, "embedding");
    const tEmbed = Date.now();
    try {
      const result = await embedBatch(inserted.map((c) => c.content));
      if (result && result.vectors.length === inserted.length) {
        tokensUsed = result.tokensUsed;
        // 7. qdrant upsert
        const points = inserted.map((c, i) => ({
          id: randomUUID(),
          vector: result.vectors[i],
          payload: {
            document_id: doc.id,
            chunk_id: c.id,
            chunk_idx: c.chunk_idx,
            filename: doc.filename,
            kind: doc.kind,
            uploaded_by: doc.uploaded_by,
            tags: doc.tags,
            content: c.content,
            created_at: c.created_at,
          },
        }));
        await upsertBrainPoints(points);
        await markChunksEmbedded(
          inserted.map((c) => c.id),
          points.map((p) => p.id),
        );
        await recordJob(doc.id, "embed", "succeeded", {
          durationMs: Date.now() - tEmbed,
        });
        await trackEvent("brain.embedding_succeeded", req.uploadedBy, req.uploaderRole, {
          document_id: doc.id,
          chunk_count: inserted.length,
          tokens_used: tokensUsed,
        });
      } else {
        await recordJob(doc.id, "embed", "failed", {
          durationMs: Date.now() - tEmbed,
          error: "embedder returned no vectors or count mismatch",
        });
      }
    } catch (err) {
      await recordJob(doc.id, "embed", "failed", {
        durationMs: Date.now() - tEmbed,
        error: (err as Error).message,
      });
      await trackEvent("brain.embedding_skipped", req.uploadedBy, req.uploaderRole, {
        document_id: doc.id,
        reason: (err as Error).message.slice(0, 200),
      });
    }
  } else {
    await recordJob(doc.id, "embed", "skipped", {
      error: "OPENAI_API_KEY not configured",
    });
    await trackEvent("brain.embedding_skipped", req.uploadedBy, req.uploaderRole, {
      document_id: doc.id,
      reason: "not_configured",
    });
  }

  // 8. finalize
  await updateDocumentStats(doc.id, capped.text.length, inserted.length, tokensUsed);
  await updateDocumentStatus(
    doc.id,
    "indexed",
    capped.truncated
      ? `extraction truncated at ${capped.text.length} chars (original ${capped.originalLength})`
      : null,
  );
  await trackEvent("brain.document_indexed", req.uploadedBy, req.uploaderRole, {
    document_id: doc.id,
    kind,
    chunk_count: inserted.length,
    extracted_chars: capped.text.length,
    tokens_used: tokensUsed,
  });

  return {
    document_id: doc.id,
    status: "indexed",
    chunk_count: inserted.length,
    extracted_chars: capped.text.length,
  };
}

/** Error type exported so route handlers can translate to HTTP codes. */
export class BrainIngestError extends Error {
  constructor(
    public readonly code: "empty_file" | "too_large" | "unauthorized" | "internal",
    message: string,
  ) {
    super(message);
    this.name = "BrainIngestError";
  }
  public toHttpStatus(): number {
    switch (this.code) {
      case "empty_file":
        return 400;
      case "too_large":
        return 413;
      case "unauthorized":
        return 401;
      default:
        return 500;
    }
  }
}
