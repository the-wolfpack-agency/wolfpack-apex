/**
 * brain_* table CRUD — one module, no leakage into route handlers.
 *
 * Every mutation in here fires a trackEvent call so the learning loop
 * consumes Brain activity (per the no-data-lost directive). Failures
 * surface as thrown errors; upstream route handlers translate to HTTP.
 */

import { createHash } from "node:crypto";
import { query } from "@/lib/db";
import { trackEvent, type InstinctEventType } from "@/lib/analytics";
import type {
  BrainChunk,
  BrainDocument,
  BrainJobStatus,
  BrainJobType,
  BrainKind,
  BrainStatus,
} from "./types";

export function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

// ── documents ──────────────────────────────────────────────────────

export interface CreateDocArgs {
  filename: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  kind: BrainKind;
  uploadedBy: string;
  uploaderRole: string;
  tags?: string[];
  msDriveItemId?: string | null;
  msFileLocalId?: string | null;
  webUrl?: string | null;
}

export async function findDocumentBySha(sha: string): Promise<BrainDocument | null> {
  const res = await query<BrainDocument>(
    `SELECT * FROM brain_documents WHERE sha256 = $1 LIMIT 1`,
    [sha],
  );
  return res.rows[0] ?? null;
}

export async function getDocument(id: string): Promise<BrainDocument | null> {
  const res = await query<BrainDocument>(
    `SELECT * FROM brain_documents WHERE id = $1 LIMIT 1`,
    [id],
  );
  return res.rows[0] ?? null;
}

/** Batch fetch citation-render data (filename + web_url) for a list of
 *  document IDs. Used by the chat layer to convert [ref:<id>] citation
 *  markers into clickable Sources links. Returns one row per id that
 *  exists, in the same order as the input array. Missing IDs are
 *  filtered out (citation validator already strips invented refs). */
export async function getCitationRefs(
  ids: string[],
): Promise<Array<{ id: string; filename: string; web_url: string | null }>> {
  if (ids.length === 0) return [];
  const res = await query<{ id: string; filename: string; web_url: string | null }>(
    `SELECT id, filename, web_url
       FROM brain_documents
      WHERE id = ANY($1::uuid[])`,
    [ids],
  );
  /* Preserve input order so the rendered Sources list matches the
   * order citations appear in the answer. */
  const byId = new Map(res.rows.map((r) => [r.id, r]));
  return ids.map((id) => byId.get(id)).filter((r): r is { id: string; filename: string; web_url: string | null } => Boolean(r));
}

export async function listDocuments(opts: {
  uploadedBy?: string;
  kind?: BrainKind;
  status?: BrainStatus;
  tag?: string;
  limit?: number;
  offset?: number;
} = {}): Promise<BrainDocument[]> {
  const where: string[] = [];
  const args: unknown[] = [];
  if (opts.uploadedBy) {
    args.push(opts.uploadedBy);
    where.push(`uploaded_by = $${args.length}`);
  }
  if (opts.kind) {
    args.push(opts.kind);
    where.push(`kind = $${args.length}`);
  }
  if (opts.status) {
    args.push(opts.status);
    where.push(`status = $${args.length}`);
  }
  if (opts.tag) {
    args.push(opts.tag);
    where.push(`$${args.length} = ANY(tags)`);
  }
  const sql = `
    SELECT * FROM brain_documents
    ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY created_at DESC
    LIMIT ${Math.min(Math.max(opts.limit ?? 50, 1), 500)}
    OFFSET ${Math.max(opts.offset ?? 0, 0)}
  `;
  const res = await query<BrainDocument>(sql, args);
  return res.rows;
}

export async function createDocument(
  args: CreateDocArgs,
): Promise<BrainDocument> {
  const res = await query<BrainDocument>(
    `INSERT INTO brain_documents
        (ms_drive_item_id, ms_file_local_id, web_url,
         filename, content_type, size_bytes, sha256,
         kind, status, uploaded_by, uploader_role, tags)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'queued', $9, $10, $11)
     RETURNING *`,
    [
      args.msDriveItemId ?? null,
      args.msFileLocalId ?? null,
      args.webUrl ?? null,
      args.filename,
      args.contentType,
      args.sizeBytes,
      args.sha256,
      args.kind,
      args.uploadedBy,
      args.uploaderRole,
      args.tags ?? [],
    ],
  );
  const doc = res.rows[0];
  await safeTrack("brain.upload_completed", args.uploadedBy, args.uploaderRole, {
    document_id: doc.id,
    kind: doc.kind,
    size_bytes: doc.size_bytes,
    content_type: doc.content_type,
  });
  return doc;
}

export async function updateDocumentStatus(
  id: string,
  status: BrainStatus,
  detail?: string | null,
): Promise<void> {
  await query(
    `UPDATE brain_documents
        SET status = $1,
            status_detail = $2,
            updated_at = NOW(),
            indexed_at = CASE WHEN $1 = 'indexed' THEN NOW() ELSE indexed_at END
      WHERE id = $3`,
    [status, detail ?? null, id],
  );
}

export async function updateDocumentStats(
  id: string,
  extractedChars: number,
  chunkCount: number,
  tokensUsed: number,
): Promise<void> {
  await query(
    `UPDATE brain_documents
        SET extracted_chars = $1,
            chunk_count = $2,
            tokens_used = tokens_used + $3,
            updated_at = NOW()
      WHERE id = $4`,
    [extractedChars, chunkCount, tokensUsed, id],
  );
}

export async function deleteDocument(id: string): Promise<BrainDocument | null> {
  const existing = await getDocument(id);
  if (!existing) return null;
  // CASCADE removes chunks + jobs
  await query(`DELETE FROM brain_documents WHERE id = $1`, [id]);
  await safeTrack("brain.document_deleted", existing.uploaded_by, existing.uploader_role, {
    document_id: id,
    kind: existing.kind,
  });
  return existing;
}

// ── chunks ─────────────────────────────────────────────────────────

export async function insertChunks(
  documentId: string,
  chunks: { idx: number; content: string; tokenEstimate: number }[],
): Promise<BrainChunk[]> {
  if (chunks.length === 0) return [];
  // Bulk insert via unnest — one round trip regardless of chunk count
  const idxs = chunks.map((c) => c.idx);
  const contents = chunks.map((c) => c.content);
  const tokens = chunks.map((c) => c.tokenEstimate);
  const res = await query<BrainChunk>(
    `INSERT INTO brain_chunks (document_id, chunk_idx, content, token_estimate)
     SELECT $1, i::int, c, t::int
       FROM unnest($2::int[], $3::text[], $4::int[]) AS u(i, c, t)
     RETURNING *`,
    [documentId, idxs, contents, tokens],
  );
  return res.rows;
}

export async function markChunksEmbedded(
  chunkIds: string[],
  qdrantPointIds: string[],
): Promise<void> {
  if (chunkIds.length === 0) return;
  await query(
    `UPDATE brain_chunks bc
        SET embedded = TRUE,
            qdrant_point_id = u.pid
       FROM unnest($1::uuid[], $2::text[]) AS u(cid, pid)
      WHERE bc.id = u.cid`,
    [chunkIds, qdrantPointIds],
  );
}

export async function getChunksForDocument(documentId: string): Promise<BrainChunk[]> {
  const res = await query<BrainChunk>(
    `SELECT * FROM brain_chunks WHERE document_id = $1 ORDER BY chunk_idx ASC`,
    [documentId],
  );
  return res.rows;
}

// ── jobs ───────────────────────────────────────────────────────────

export async function recordJob(
  documentId: string,
  jobType: BrainJobType,
  status: BrainJobStatus,
  opts: { error?: string; durationMs?: number } = {},
): Promise<void> {
  await query(
    `INSERT INTO brain_jobs (document_id, job_type, status, error, duration_ms,
                              started_at, finished_at, attempts)
     VALUES ($1, $2, $3, $4, $5, NOW(), NOW(), 1)`,
    [documentId, jobType, status, opts.error ?? null, opts.durationMs ?? null],
  );
}

// ── keyword retrieval ──────────────────────────────────────────────

export interface KeywordHit {
  chunk_id: string;
  document_id: string;
  chunk_idx: number;
  filename: string;
  kind: BrainKind;
  content: string;
  score: number;
  headline: string;
  [key: string]: unknown;
}

export async function keywordSearch(
  queryText: string,
  limit: number,
  opts: { uploadedBy?: string; kind?: BrainKind } = {},
): Promise<KeywordHit[]> {
  const where: string[] = [`bc.tsv @@ websearch_to_tsquery('english', $1)`];
  const args: unknown[] = [queryText];
  if (opts.uploadedBy) {
    args.push(opts.uploadedBy);
    where.push(`bd.uploaded_by = $${args.length}`);
  }
  if (opts.kind) {
    args.push(opts.kind);
    where.push(`bd.kind = $${args.length}`);
  }
  args.push(limit);
  const sql = `
    SELECT bc.id AS chunk_id,
           bc.document_id,
           bc.chunk_idx,
           bd.filename,
           bd.kind,
           bc.content,
           ts_rank_cd(bc.tsv, websearch_to_tsquery('english', $1)) AS score,
           ts_headline('english', bc.content, websearch_to_tsquery('english', $1),
                       'MaxFragments=2,MinWords=5,MaxWords=18') AS headline
      FROM brain_chunks bc
      JOIN brain_documents bd ON bd.id = bc.document_id
     WHERE ${where.join(" AND ")}
       AND bd.status = 'indexed'
     ORDER BY score DESC
     LIMIT $${args.length}
  `;
  const res = await query<KeywordHit>(sql, args);
  return res.rows;
}

// ── query log ──────────────────────────────────────────────────────

export async function logQuery(args: {
  userId: string;
  userRole: string;
  query: string;
  scope?: string | null;
  hitChunkIds: string[];
  keywordHits: number;
  semanticHits: number;
  latencyMs: number;
  tokensUsed: number;
  conversationId?: string | null;
}): Promise<number> {
  const res = await query<{ id: number }>(
    `INSERT INTO brain_query_log
        (user_id, user_role, query, scope, hit_chunk_ids, hit_count,
         keyword_hits, semantic_hits, latency_ms, tokens_used, conversation_id)
     VALUES ($1, $2, $3, $4, $5::uuid[], $6, $7, $8, $9, $10, $11)
     RETURNING id`,
    [
      args.userId,
      args.userRole,
      args.query,
      args.scope ?? null,
      args.hitChunkIds,
      args.hitChunkIds.length,
      args.keywordHits,
      args.semanticHits,
      args.latencyMs,
      args.tokensUsed,
      args.conversationId ?? null,
    ],
  );
  return res.rows[0].id;
}

export async function markQueryCited(queryLogId: number): Promise<void> {
  await query(`UPDATE brain_query_log SET cited = TRUE WHERE id = $1`, [queryLogId]);
}

// ── internals ──────────────────────────────────────────────────────

async function safeTrack(
  event: InstinctEventType,
  userId: string,
  userRole: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  try {
    await trackEvent(
      event,
      userId,
      userRole,
      metadata as Record<string, string | number | boolean>,
    );
  } catch {
    // analytics is never allowed to break an ingest write
  }
}
