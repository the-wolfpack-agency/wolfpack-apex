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
  /** Attempts per batch before giving up. Backs off between tries. */
  maxAttempts?: number;
  /** Pause between batches, to stay under the deployment's tokens-per-minute. */
  pauseMs?: number;
}

export interface BackfillResult {
  /** Chunks that were embedded and stored. */
  embedded: number;
  /** Chunks still waiting when this returned. */
  remaining: number;
  /** Batches that threw. The rows stay false and are retried next time, which
   *  is the point of resumability. */
  failedBatches: number;
  /** WHY it stopped. "failed batches: 1" without this is a number that sends
   *  somebody to the logs to find out what a script already knew. */
  lastError: string | null;
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
  const maxAttempts = Math.max(opts.maxAttempts ?? 4, 1);
  const pauseMs = Math.max(opts.pauseMs ?? 1_200, 0);

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
  let lastError: string | null = null;

  while (embedded < target) {
    const batch = await takePending(Math.min(batchSize, target - embedded));
    if (batch.length === 0) break;

    if (dryRun) {
      /* THE WHOLE BACKLOG, NOT THE FIRST BATCH. A dry run reads one batch to
         prove the query and the config work, then stops, because it marks
         nothing and would otherwise loop on the same rows forever. Reporting
         that batch as the total said "would embed 32" for a backlog of 2,305,
         which is the same shape of misleading number this file exists to
         stop producing. */
      embedded = target;
      opts.onProgress?.(embedded, target);
      break;
    }

    try {
      /* RETRIED, BECAUSE THE COMMON FAILURE IS TEMPORARY AND UNNAMED.
       *
       * The Azure adapter documents that it NEVER throws: every failure comes
       * back as an empty array plus an analytics event. So a rate limit, an
       * expired key and a network blip are indistinguishable here, and the
       * first run of this backfill stopped after 208 chunks on "embedder
       * returned 0 vectors for 8 chunks" with no way to tell which.
       *
       * At roughly 750 tokens a chunk, eight at a time with no pause runs at
       * about 156k tokens a minute against a 120k deployment, so the likeliest
       * answer is the one a backfill should simply absorb. Backing off and
       * trying again costs seconds; stopping costs a person. */
      let result: Awaited<ReturnType<typeof embedBatch>> = null;
      let attemptError = "";
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        result = await embedBatch(batch.map((c) => c.content));
        if (result && result.vectors.length === batch.length) break;
        attemptError = `embedder returned ${result?.vectors.length ?? 0} vectors for ${batch.length} chunks`;
        result = null;
        if (attempt < maxAttempts) {
          await new Promise((r) => setTimeout(r, pauseMs * 2 ** attempt));
        }
      }
      if (!result) {
        /* A short vector list silently mismatched to chunks would attach the
           wrong meaning to the right document, which is worse than no
           embedding at all. */
        throw new Error(`${attemptError} after ${maxAttempts} attempts`);
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
      /* Paced on purpose. A backfill has nowhere to be, and running it flat out
         against a shared deployment steals capacity from the live product. */
      if (pauseMs > 0 && embedded < target) {
        await new Promise((r) => setTimeout(r, pauseMs));
      }
    } catch (err) {
      failedBatches += 1;
      lastError = (err as Error)?.message?.slice(0, 300) ?? "unknown";
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
    lastError,
    backend,
    dryRun,
  };
}
