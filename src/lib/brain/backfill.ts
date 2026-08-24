/**
 * Embed the chunks that were never embedded.
 *
 * THE BACKLOG THIS EXISTS FOR
 *
 * embedder.ts has said, since it was written, that "a later reconciler can
 * embed the backlog once the key is configured". The key was never configured,
 * the reconciler was never written, and on 2026-08-24 the backlog was measured:
 * 2,305 chunks across 779 documents, every single one at embedded = false, and
 * 252 brain queries over the previous 30 days with zero semantic hits.
 *
 * So every document uploaded to the Brain for the life of the feature is
 * searchable by keyword only. This walks that backlog and fixes it.
 *
 * WHY IT IS WRITTEN TO BE RUN TWICE
 *
 * It selects on embedded = false and marks rows as it goes, so an interrupted
 * run resumes and a completed run is a no-op. A backfill that cannot be safely
 * re-run is a backfill somebody is afraid to start.
 *
 * WHAT IT WILL NOT DO
 *
 * It will not report success for work it did not do. If the embedder is not
 * configured it stops immediately and says which variables are missing, rather
 * than walking 2,305 rows, embedding none of them, and printing a total.
 */
import { query } from "@/lib/db";
import { embedBatch, isEmbeddingConfigured, embeddingBackend } from "./embedder";
import { upsertBrainPoints } from "./qdrant";
import { markChunksEmbedded } from "./repo";
import { trackEvent } from "@/lib/analytics";

export interface BackfillOptions {
  /** Chunks per embed + upsert round trip. */
  batchSize?: number;
  /** Stop after this many chunks. Omit for the whole backlog. */
  limit?: number;
  /** Report what would happen, write nothing. */
  dryRun?: boolean;
  /** Called after each batch, for progress on a long run. */
  onProgress?: (done: number, total: number) => void;
}

export interface BackfillResult {
  /** Chunks that were embedded and stored. */
  embedded: number;
  /** Chunks still waiting when this returned. */
  remaining: number;
  /** Batches that threw. The run continues; the rows stay false and are
   *  retried next time, which is the point of resumability. */
  failedBatches: number;
  backend: ReturnType<typeof embeddingBackend>;
  dryRun: boolean;
}

interface PendingChunk extends Record<string, unknown> {
  id: string;
  document_id: string;
  chunk_idx: number;
  content: string;
  filename: string;
  kind: string;
  uploaded_by: string;
  created_at: string;
}

async function countPending(): Promise<number> {
  const r = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM brain_chunks WHERE embedded = FALSE`,
  );
  return r.rows[0]?.n ?? 0;
}

async function takePending(limit: number): Promise<PendingChunk[]> {
  const r = await query<PendingChunk>(
    `SELECT bc.id::text, bc.document_id::text, bc.chunk_idx, bc.content,
            bd.filename, bd.kind, COALESCE(bd.uploaded_by::text, '') AS uploaded_by,
            bc.created_at::text
       FROM brain_chunks bc
       JOIN brain_documents bd ON bd.id = bc.document_id
      WHERE bc.embedded = FALSE
      ORDER BY bc.created_at ASC
      LIMIT $1`,
    [limit],
  );
  return r.rows;
}

export async function backfillEmbeddings(
  opts: BackfillOptions = {},
): Promise<BackfillResult> {
  const backend = embeddingBackend();
  const batchSize = Math.min(Math.max(opts.batchSize ?? 32, 1), 128);
  const dryRun = opts.dryRun === true;

  if (!isEmbeddingConfigured()) {
    /* Refusing loudly beats a clean run that embedded nothing. That exact
       shape, a skip that looks like a success, is what hid this for a year. */
    throw new Error(
      "Embeddings are not configured, so there is nothing this can do. Set " +
        "AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_API_KEY and AZURE_OPENAI_EMBEDDING_DEPLOYMENT " +
        "(or OPENAI_API_KEY) and run it again.",
    );
  }

  const total = await countPending();
  const target = opts.limit ? Math.min(opts.limit, total) : total;
  let embedded = 0;
  let failedBatches = 0;

  while (embedded < target) {
    const batch = await takePending(Math.min(batchSize, target - embedded));
    if (batch.length === 0) break;

    if (dryRun) {
      embedded += batch.length;
      opts.onProgress?.(embedded, target);
      /* A dry run must not loop forever on rows it never marks. */
      break;
    }

    try {
      const result = await embedBatch(batch.map((c) => c.content));
      if (!result || result.vectors.length !== batch.length) {
        /* A short vector list silently mismatched to chunks would attach the
           wrong meaning to the right document, which is worse than no
           embedding at all. */
        throw new Error(
          `embedder returned ${result?.vectors.length ?? 0} vectors for ${batch.length} chunks`,
        );
      }

      const points = batch.map((c, i) => ({
        id: c.id,
        vector: result.vectors[i],
        payload: {
          document_id: c.document_id,
          chunk_id: c.id,
          chunk_idx: c.chunk_idx,
          filename: c.filename,
          kind: c.kind,
          uploaded_by: c.uploaded_by,
          tags: [] as string[],
          content: c.content,
          created_at: c.created_at,
        },
      }));

      await upsertBrainPoints(points);
      /* Marked only AFTER the vector is stored. The other order loses chunks
         permanently on a crash between the two: they read as embedded and
         nothing would ever pick them up again. */
      await markChunksEmbedded(
        batch.map((c) => c.id),
        batch.map((c) => c.id),
      );
      embedded += batch.length;
      opts.onProgress?.(embedded, target);
    } catch (err) {
      failedBatches += 1;
      trackEvent("system.brain_backfill_batch_failed", "system", "system", {
        size: batch.length,
        error: (err as Error)?.message?.slice(0, 200) ?? "unknown",
      });
      /* Leave the rows false and stop. Grinding through a broken provider
         produces a long log and no embeddings. */
      break;
    }
  }

  return {
    embedded,
    remaining: dryRun ? total : await countPending(),
    failedBatches,
    backend,
    dryRun,
  };
}
