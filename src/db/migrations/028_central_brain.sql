-- Migration 028: Central Brain — team knowledge ingestion + RAG
--
-- Paired code:
--   src/lib/brain/*                (extractors, chunker, ingest, query)
--   src/app/api/brain/*            (ingest / documents / query routes)
--   src/app/(dashboard)/brain/     (upload + library UI)
--
-- Storage strategy:
--   - OneDrive (Graph) holds the original file bytes (already wired via
--     src/lib/integrations/microsoft-files.ts). We never duplicate bytes.
--   - Postgres holds the extracted text split into semantic chunks, plus
--     per-document metadata, status, and a Postgres full-text search
--     index so retrieval works even when Qdrant/embeddings are absent.
--   - Qdrant (apex_brain collection) holds per-chunk embeddings for
--     semantic RAG. Writes are best-effort via tripleWriteBrain; a
--     Qdrant outage never blocks ingestion or retrieval.
--   - Neo4j records (:BrainDocument)-[:HAS_CHUNK]->(:BrainChunk) and
--     (:User)-[:INGESTED]->(:BrainDocument) so the learning graph can
--     reason about who contributed which knowledge.

-- ── brain_documents: one row per uploaded file ─────────────────────
CREATE TABLE IF NOT EXISTS brain_documents (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ms_drive_item_id TEXT,                    -- OneDrive Graph id (null if pre-storage)
    ms_file_local_id UUID REFERENCES instinct_ms_files_metadata(id) ON DELETE SET NULL,
    web_url         TEXT,
    filename        TEXT NOT NULL,
    content_type    TEXT NOT NULL,
    size_bytes      BIGINT NOT NULL,
    sha256          TEXT NOT NULL,            -- dedupe key; re-uploads become updates
    kind            TEXT NOT NULL CHECK (kind IN (
                       'pdf','docx','text','markdown','csv','html',
                       'audio','video','image','email','other')),
    status          TEXT NOT NULL DEFAULT 'queued' CHECK (status IN (
                       'queued','extracting','chunking','embedding',
                       'indexed','failed','skipped')),
    status_detail   TEXT,                     -- free-form when status='failed'
    extracted_chars INTEGER NOT NULL DEFAULT 0,
    chunk_count     INTEGER NOT NULL DEFAULT 0,
    tokens_used     INTEGER NOT NULL DEFAULT 0,  -- extraction + embedding costs
    uploaded_by     TEXT NOT NULL,            -- user.id
    uploader_role   TEXT NOT NULL,
    tags            TEXT[] NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    indexed_at      TIMESTAMPTZ,
    UNIQUE (sha256)  -- content-dedupe
);
CREATE INDEX IF NOT EXISTS brain_documents_uploader_idx ON brain_documents(uploaded_by);
CREATE INDEX IF NOT EXISTS brain_documents_status_idx ON brain_documents(status);
CREATE INDEX IF NOT EXISTS brain_documents_kind_idx ON brain_documents(kind);
CREATE INDEX IF NOT EXISTS brain_documents_tags_idx ON brain_documents USING GIN (tags);


-- ── brain_chunks: one row per semantic chunk ───────────────────────
CREATE TABLE IF NOT EXISTS brain_chunks (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id   UUID NOT NULL REFERENCES brain_documents(id) ON DELETE CASCADE,
    chunk_idx     INTEGER NOT NULL,
    content       TEXT NOT NULL,
    token_estimate INTEGER NOT NULL DEFAULT 0,
    -- Text-search vector so keyword RAG works without Qdrant. GENERATED
    -- + STORED means every UPDATE to `content` reindexes automatically.
    tsv           TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
    qdrant_point_id TEXT,                   -- populated only after Qdrant upsert succeeds
    embedded      BOOLEAN NOT NULL DEFAULT FALSE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (document_id, chunk_idx)
);
CREATE INDEX IF NOT EXISTS brain_chunks_tsv_idx ON brain_chunks USING GIN (tsv);
CREATE INDEX IF NOT EXISTS brain_chunks_document_idx ON brain_chunks(document_id, chunk_idx);
CREATE INDEX IF NOT EXISTS brain_chunks_embedded_idx ON brain_chunks(embedded) WHERE embedded = FALSE;


-- ── brain_jobs: async extraction queue (audio / video / long PDFs) ──
-- Even sync extractions write a job row so the UI can display progress
-- and the learning loop has a durable record of every attempt.
CREATE TABLE IF NOT EXISTS brain_jobs (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id   UUID NOT NULL REFERENCES brain_documents(id) ON DELETE CASCADE,
    job_type      TEXT NOT NULL CHECK (job_type IN ('extract','chunk','embed','transcribe','ocr')),
    status        TEXT NOT NULL DEFAULT 'queued' CHECK (status IN (
                     'queued','running','succeeded','failed','skipped')),
    attempts      INTEGER NOT NULL DEFAULT 0,
    error         TEXT,
    started_at    TIMESTAMPTZ,
    finished_at   TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    duration_ms   INTEGER
);
CREATE INDEX IF NOT EXISTS brain_jobs_document_idx ON brain_jobs(document_id, job_type);
CREATE INDEX IF NOT EXISTS brain_jobs_status_idx ON brain_jobs(status);
CREATE INDEX IF NOT EXISTS brain_jobs_created_at_idx ON brain_jobs(created_at DESC);


-- ── brain_query_log: every RAG query, for the learning loop ────────
-- Every retrieval persists: query text, intent, hit ids, tokens used,
-- whether the assistant's final answer cited the hits. Directly feeds
-- the eval harness and ties the brain into the data/learning directive
-- (no data lost, all data consumed).
CREATE TABLE IF NOT EXISTS brain_query_log (
    id             BIGSERIAL PRIMARY KEY,
    user_id        TEXT NOT NULL,
    user_role      TEXT NOT NULL,
    query          TEXT NOT NULL,
    scope          TEXT,                    -- optional team/tag filter
    hit_chunk_ids  UUID[] NOT NULL DEFAULT '{}',
    hit_count      INTEGER NOT NULL DEFAULT 0,
    keyword_hits   INTEGER NOT NULL DEFAULT 0,
    semantic_hits  INTEGER NOT NULL DEFAULT 0,
    latency_ms     INTEGER NOT NULL DEFAULT 0,
    tokens_used    INTEGER NOT NULL DEFAULT 0,
    cited          BOOLEAN NOT NULL DEFAULT FALSE,
    conversation_id TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS brain_query_log_user_idx ON brain_query_log(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS brain_query_log_created_at_idx ON brain_query_log(created_at DESC);


-- ── Views for the learning loop ────────────────────────────────────

-- Documents currently in-flight (for UI progress + dashboard health)
CREATE OR REPLACE VIEW brain_documents_in_flight AS
SELECT id, filename, kind, status, status_detail, chunk_count,
       uploaded_by, created_at, updated_at
FROM brain_documents
WHERE status IN ('queued','extracting','chunking','embedding');

-- Ingest throughput rollup — last 30 days, by kind and status
CREATE OR REPLACE VIEW brain_ingest_daily AS
SELECT
    DATE(created_at) AS day,
    kind,
    status,
    COUNT(*)                    AS n_documents,
    SUM(chunk_count)            AS total_chunks,
    SUM(extracted_chars)        AS total_chars,
    SUM(tokens_used)            AS total_tokens,
    AVG(EXTRACT(EPOCH FROM (updated_at - created_at)))::INTEGER AS avg_seconds
FROM brain_documents
WHERE created_at > NOW() - INTERVAL '30 days'
GROUP BY DATE(created_at), kind, status;

-- Query-quality rollup — how often a retrieved chunk gets cited
CREATE OR REPLACE VIEW brain_query_quality_daily AS
SELECT
    DATE(created_at) AS day,
    COUNT(*)                        AS n_queries,
    SUM(hit_count)                  AS total_hits,
    SUM(CASE WHEN cited THEN 1 ELSE 0 END) AS n_cited,
    AVG(latency_ms)::INTEGER        AS avg_latency_ms,
    SUM(tokens_used)                AS total_tokens
FROM brain_query_log
WHERE created_at > NOW() - INTERVAL '30 days'
GROUP BY DATE(created_at);
