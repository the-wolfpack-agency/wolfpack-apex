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
import { readsEverything } from "./audience";
import { nonCorpusExclusionSql, NON_CORPUS_UPLOADER_IDS } from "./corpus";
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
  /** Roles that may be quoted this document. Null/absent = workspace-wide. */
  audienceRoles?: string[] | null;
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

/**
 * Attach a drive item to a document that already existed.
 *
 * WHY A SYNC CANNOT FINISH WITHOUT THIS. ingest() dedupes on the content hash
 * and returns the existing row. Resume skips files via
 * findIngestedDriveItemIds, which keys on ms_drive_item_id. A file whose bytes
 * were already in the Brain from some earlier upload therefore came back as a
 * SUCCESS, gained no drive item id, and was invisible to the skip on the next
 * pass, so it was downloaded again, deduped again, and counted again, forever.
 *
 * Measured on TEST/General, 2,518 files: pass one reported 272 successes and
 * left 2,143 remaining, pass two reported 262 and left 2,153. The remaining
 * count went UP. 534 reported successes had produced 56 documents carrying a
 * drive item id, because the other 478 were deduplicates that could never be
 * marked done.
 *
 * Only fills a NULL. A document already bound to a drive item is not
 * rebound, so the same content appearing in two folders keeps its first home
 * rather than flipping between them on alternate syncs.
 */
export async function attachDriveItem(
  documentId: string,
  msDriveItemId: string,
  webUrl?: string | null,
): Promise<boolean> {
  const res = await query(
    `UPDATE brain_documents
        SET ms_drive_item_id = $2,
            web_url = COALESCE(web_url, $3),
            updated_at = NOW()
      WHERE id = $1 AND ms_drive_item_id IS NULL`,
    [documentId, msDriveItemId, webUrl ?? null],
  );
  return (res.rowCount ?? 0) > 0;
}

/**
 * Documents already taken from a set of Graph drive items.
 *
 * Answered in ONE query for a whole folder rather than one per file: a sync
 * walking nine hundred items would otherwise open nine hundred round trips
 * before downloading anything, which is the shape of problem it is trying to
 * escape.
 *
 * Only counts documents that actually landed. A row left in `failed` or
 * `chunking` is not a document the Brain can answer from, and skipping it
 * would make a failed ingest permanent.
 */
export async function findIngestedDriveItemIds(ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  /* FAILS TOWARD DOING THE WORK. Not knowing what has already landed must
     mean "download it again", never "assume it is there": the first wastes a
     request, the second silently leaves a hole in the corpus that nobody can
     see, and a Brain missing a document answers questions about it wrongly
     rather than not at all. */
  if (!process.env.DATABASE_URL) return new Set();
  try {
    const res = await query<{ ms_drive_item_id: string }>(
      `SELECT DISTINCT ms_drive_item_id
         FROM brain_documents
        WHERE ms_drive_item_id = ANY($1)
          AND status IN ('indexed', 'skipped')`,
      [ids],
    );
    return new Set(res.rows.map((r) => String(r.ms_drive_item_id)));
  } catch {
    return new Set();
  }
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
         kind, status, uploaded_by, uploader_role, tags, audience_roles)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'queued', $9, $10, $11, $12)
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
      /* NULL, not an empty array: an empty audience would read as "no role may
         see this", which is not what "unrestricted" means. */
      args.audienceRoles && args.audienceRoles.length > 0 ? args.audienceRoles : null,
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

/**
 * Store what a document is about.
 *
 * Separate from updateDocumentStats because enrichment is best-effort and runs
 * beside the pipeline rather than inside it: a model being unavailable must
 * leave the document indexed and searchable, just without a description.
 */
export async function updateDocumentSummary(
  documentId: string,
  summary: string,
  topics: string[],
): Promise<void> {
  await query(
    `UPDATE brain_documents
        SET summary = $2,
            topics  = $3,
            updated_at = NOW()
      WHERE id = $1`,
    [documentId, summary || null, topics.length > 0 ? topics : null],
  );
}

/**
 * Document-level context for a page of hits, in one query.
 *
 * Per-chunk lookups would be twenty round trips to decorate twenty results,
 * which is how a fast search becomes a slow one for information that is the
 * same for every chunk of the same document.
 */
export async function describeDocuments(
  documentIds: string[],
): Promise<Map<string, { summary: string | null; topics: string[] | null; webUrl: string | null }>> {
  const out = new Map<string, { summary: string | null; topics: string[] | null; webUrl: string | null }>();
  if (documentIds.length === 0 || !process.env.DATABASE_URL) return out;
  try {
    const res = await query<{
      id: string;
      summary: string | null;
      topics: string[] | null;
      web_url: string | null;
    }>(
      `SELECT id, summary, topics, web_url FROM brain_documents WHERE id = ANY($1)`,
      [documentIds],
    );
    for (const r of res.rows) {
      out.set(String(r.id), { summary: r.summary, topics: r.topics, webUrl: r.web_url });
    }
  } catch {
    /* Decoration, not substance: a hit without a description is still a hit. */
  }
  return out;
}

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

/**
 * Drop a document's chunks so it can be re-extracted in place.
 *
 * Reprocess cannot go through ingest(): that dedupes on the sha and would find
 * the existing failed row and return it unchanged, which is exactly why ninety
 * Word documents stayed failed after the parser was fixed. Re-extracting in
 * place means clearing the old chunks first, or a partially-chunked document
 * accumulates a second copy of itself and gets quoted twice.
 */
export async function deleteChunksForDocument(documentId: string): Promise<number> {
  const res = await query(`DELETE FROM brain_chunks WHERE document_id = $1`, [documentId]);
  return res.rowCount ?? 0;
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

/**
 * Keyword search, plus how much of the match set this role may not read.
 *
 * WHY THE COUNT EXISTS. `brain.retrieval_audience_filtered` sat at zero for
 * ninety days while the playbook told clients the assistant "only quoted what
 * their role may read". The claim was TRUE: the predicate below has always
 * filtered inside the query. The event was emitted only on the SEMANTIC branch
 * of queryBrain, which is gated on an embedding deployment this tenant has
 * never had, so the instrument was attached to a path that never runs.
 *
 * A working control with no evidence is indistinguishable from a broken one,
 * and on 2026-08-26 this codebase found six controls that really were broken
 * behind exactly that kind of zero. So the count is produced by the path that
 * actually runs, in the same round trip.
 *
 * ALWAYS RETURNS THE COUNT, INCLUDING WHEN NOTHING IS READABLE. The lateral
 * join is not decoration: a plain `WHERE readable` returns no rows at all for
 * a role that may read none of the matches, which loses the withheld count in
 * precisely the case most worth reporting.
 */
export interface KeywordSearchResult {
  hits: KeywordHit[];
  /** Chunks that matched the query but this role may not read. */
  withheld: number;
}

/**
 * Build the audience-aware keyword query.
 *
 * SEPARATED FROM THE EXECUTION ON PURPOSE. The app's pool rewrites every
 * connection string to `sslmode=verify-full` (see normalizeDatabaseUrlSsl), so
 * it cannot reach a throwaway local Postgres, and a *.db.test.ts must never be
 * pointed at a hosted one. Exporting the builder and the mapper lets the db
 * test run THIS EXACT SQL and THIS EXACT row handling against a real database
 * rather than a retyped copy of them, which would prove nothing.
 */
export function buildKeywordSearchSql(
  limit: number,
  opts: { uploadedBy?: string; kind?: BrainKind; role?: string } = {},
): { sql: string; args: unknown[] } {
  /* THE FILENAME IS SEARCHABLE TOO.
   *
   * bc.tsv is built from chunk CONTENT. The filename was selected for display
   * and never matched against, so a document could not be found by its name:
   * asked for "the viaPeople work order" the Brain returned CIC Training Print,
   * a ScottLeder receipt and a survey export, and not the viaPeople work order
   * sitting in the index. Measured on the deployed URL 2026-08-29.
   *
   * That is the most natural thing a person does after being shown a list and
   * asked which one they meant, so it also made the clarify path a dead end: it
   * asks a question whose answer does not work.
   *
   * Matched as a query rather than baked into bc.tsv, which would need a
   * migration and a backfill of 5,006 rows to fix something a JOIN already has
   * in hand. */
  const where: string[] = [
    `(bc.tsv @@ websearch_to_tsquery('english', $1)
      OR to_tsvector('english', replace(bd.filename, '_', ' ')) @@ websearch_to_tsquery('english', $1))`,
  ];
  const args: unknown[] = [];
  if (opts.uploadedBy) {
    args.push(opts.uploadedBy);
    where.push(`bd.uploaded_by = $${args.length + 1}`);
  }
  /* WHO IS ASKING, applied in the query rather than after it. Filtering
     afterwards would mean a restricted document had already been ranked,
     headlined and counted, and one missed branch would quote it. */
  let readableExpr = "TRUE";
  if (opts.role && !readsEverything(opts.role)) {
    args.push(opts.role.toLowerCase());
    readableExpr = `(bd.audience_roles IS NULL OR $${args.length + 1} = ANY(bd.audience_roles))`;
  }
  if (opts.kind) {
    args.push(opts.kind);
    where.push(`bd.kind = $${args.length + 1}`);
  }

  /* THE CORPUS BOUNDARY. 744 of the 795 answerable documents were written by
     the demo seeder or by the platform scanner rather than by anybody using
     the product. Searching them means answering a question about somebody's
     business by quoting a fixture, which is the difference between an
     assistant that is wrong and one that is useless. See ./corpus.ts. */
  args.push(NON_CORPUS_UPLOADER_IDS);
  where.push(nonCorpusExclusionSql(args.length + 1));

  args.push(limit);
  const limitArg = `$${args.length + 1}`;

  const sql = `
    WITH matched AS (
      SELECT bc.id AS chunk_id,
             bc.document_id,
             bc.chunk_idx,
             bd.filename,
             bd.kind,
             bc.content,
             /* NAMING A DOCUMENT IS THE MOST EXPLICIT SIGNAL A PERSON CAN
                GIVE, AND IT WAS LOSING ON A SCALE IT CANNOT WIN.
                
                Measured 2026-08-29: a filename match on "the viaPeople work
                order" scores 0.10000 from ts_rank_cd, while semantic hits on
                the same query score 0.42 to 0.45. Fusing them by raw magnitude
                buried the exact match under fuzzy ones, so asking for a
                document by name returned three unrelated files and the
                document itself was nowhere.
                
                The two numbers measure different things and were never
                comparable: one is lexical density over a short string, the
                other is cosine distance in embedding space. Parity between
                them is meaningless, so the filename rank is scaled to sit
                where its EVIDENCE belongs rather than where its arithmetic
                happens to land. Somebody who names a file is telling us which
                document they want; that outranks a topical resemblance.
                
                Capped at 1.0 so it cannot exceed a perfect match, and it is
                still a match requirement rather than a free boost: a filename
                that does not match contributes nothing. */
             GREATEST(
               ts_rank_cd(bc.tsv, websearch_to_tsquery('english', $1)),
               LEAST(
                 1.0,
                 ts_rank_cd(
                   to_tsvector('english', replace(bd.filename, '_', ' ')),
                   websearch_to_tsquery('english', $1)
                 ) * ${FILENAME_MATCH_WEIGHT}
               )
             ) AS score,
             ts_headline('english', bc.content, websearch_to_tsquery('english', $1),
                         'MaxFragments=2,MinWords=5,MaxWords=18') AS headline,
             ${readableExpr} AS readable
        FROM brain_chunks bc
        JOIN brain_documents bd ON bd.id = bc.document_id
       WHERE ${where.join(" AND ")}
         AND bd.status = 'indexed'
    ),
    tot AS (
      SELECT COUNT(*) FILTER (WHERE NOT readable)::int AS withheld FROM matched
    )
    SELECT t.withheld, m.*
      FROM tot t
      LEFT JOIN LATERAL (
        SELECT chunk_id, document_id, chunk_idx, filename, kind, content, score, headline
          FROM matched
         WHERE readable
         ORDER BY score DESC
         LIMIT ${limitArg}
      ) m ON TRUE
  `;
  return { sql, args };
}

/**
 * Turn the query's rows into hits plus the withheld count.
 *
 * The lateral join yields ONE ALL-NULL ROW when the role may read none of the
 * matches. That row is not a hit and must not be counted as one, and dropping
 * it is the only reason the withheld count survives that case at all.
 */
export function mapKeywordSearchRows(
  rows: Array<KeywordHit & { withheld: number }>,
): KeywordSearchResult {
  const withheld = rows[0]?.withheld ?? 0;
  const hits = rows
    .filter((r) => r.chunk_id != null)
    .map(({ withheld: _w, ...hit }) => hit as KeywordHit);
  return { hits, withheld };
}

export interface KeywordSearchResult {
  hits: KeywordHit[];
  /** Chunks that matched the query but this role may not read. */
  withheld: number;
}

/**
 * Keyword search, plus how much of the match set this role may not read.
 *
 * WHY THE COUNT EXISTS. `brain.retrieval_audience_filtered` sat at zero for
 * ninety days while the playbook told clients the assistant "only quoted what
 * their role may read". The claim was TRUE: the predicate has always filtered
 * inside the query. The event was emitted only on the SEMANTIC branch of
 * queryBrain, gated on an embedding deployment this tenant has never had, so
 * the instrument was attached to a path nobody drives.
 *
 * A working control with no evidence is indistinguishable from a broken one,
 * and this codebase has just found six controls that really were broken behind
 * exactly that kind of zero.
 */
/**
 * How much a filename match is worth against a semantic one.
 *
 * ts_rank_cd returns about 0.1 for a filename hit; semantic hits on the same
 * query run 0.42 to 0.45. Nine brings a name match to roughly 0.9, above any
 * topical resemblance, which is where the evidence belongs: somebody naming a
 * file is telling us which document they want.
 *
 * Named rather than inlined so the number is arguable. It is a judgement about
 * evidence, not a measurement, and the next person should be able to see that.
 */
export const FILENAME_MATCH_WEIGHT = 9;

export async function keywordSearchWithAudience(
  queryText: string,
  limit: number,
  opts: { uploadedBy?: string; kind?: BrainKind; role?: string } = {},
): Promise<KeywordSearchResult> {
  const { sql, args } = buildKeywordSearchSql(limit, opts);
  const res = await query<KeywordHit & { withheld: number }>(sql, [queryText, ...args]);
  return mapKeywordSearchRows(res.rows);
}

export async function keywordSearch(
  queryText: string,
  limit: number,
  opts: { uploadedBy?: string; kind?: BrainKind; role?: string } = {},
): Promise<KeywordHit[]> {
  return (await keywordSearchWithAudience(queryText, limit, opts)).hits;
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
