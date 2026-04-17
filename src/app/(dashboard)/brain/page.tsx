"use client";

/**
 * /brain — Central Brain dashboard.
 *
 * Three panels stacked mobile-first:
 *   1. Upload dropzone — drag/drop or click to pick any file
 *   2. Library grid — paginated list of ingested docs with status pills
 *   3. Query box — quick RAG search with keyword+semantic hits + snippets
 *
 * All authenticated fetches go through fetchWithRefresh (15-min JWT TTL).
 * Analytics events fire on page view + upload + query so the learning
 * loop tracks Brain usage.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchWithRefresh, jsonHeaders } from "@/lib/client-auth";

interface BrainDocument {
  id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  kind: string;
  status: string;
  status_detail: string | null;
  chunk_count: number;
  extracted_chars: number;
  tokens_used: number;
  uploaded_by: string;
  tags: string[];
  created_at: string;
  updated_at: string;
  indexed_at: string | null;
}

interface QueryHit {
  chunk_id: string;
  document_id: string;
  document_filename: string;
  document_kind: string;
  chunk_idx: number;
  content: string;
  score: number;
  source: "keyword" | "semantic" | "keyword+semantic";
  snippet: string;
}

interface QueryResponse {
  query: string;
  hits: QueryHit[];
  keyword_hits: number;
  semantic_hits: number;
  latency_ms: number;
  tokens_used: number;
  query_log_id: number;
}

const STATUS_COLORS: Record<string, string> = {
  queued: "var(--wp-muted)",
  extracting: "var(--wp-info)",
  chunking: "var(--wp-info)",
  embedding: "var(--wp-info)",
  indexed: "var(--wp-success)",
  failed: "var(--wp-error)",
  skipped: "var(--wp-warning)",
};

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export default function BrainPage() {
  const [docs, setDocs] = useState<BrainDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"mine" | "all">("mine");
  const [queryText, setQueryText] = useState("");
  const [queryResult, setQueryResult] = useState<QueryResponse | null>(null);
  const [querying, setQuerying] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<{ filename: string; status: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const loadDocs = useCallback(async () => {
    setLoading(true);
    try {
      const qs = filter === "all" ? "?uploaded_by=all&limit=100" : "?limit=100";
      const res = await fetchWithRefresh(`/api/brain/documents${qs}`);
      if (res.ok) {
        const body = await res.json();
        setDocs(body.documents || []);
      }
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    loadDocs();
    fetchWithRefresh("/api/analytics", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ event: "system.page_viewed", metadata: { page: "brain" } }),
    }).catch(() => undefined);
  }, [loadDocs]);

  const uploadFile = useCallback(
    async (file: File) => {
      if (!file) return;
      setUploadProgress({ filename: file.name, status: "uploading" });
      const form = new FormData();
      form.append("file", file);
      try {
        const res = await fetchWithRefresh("/api/brain/ingest", {
          method: "POST",
          body: form,
        });
        const body = await res.json();
        if (!res.ok) {
          setUploadProgress({ filename: file.name, status: `failed: ${body.error || res.status}` });
        } else if (body.duplicate_of) {
          setUploadProgress({ filename: file.name, status: `duplicate — already indexed (${body.status})` });
        } else {
          setUploadProgress({
            filename: file.name,
            status: `${body.status} · ${body.chunk_count} chunks · ${body.extracted_chars.toLocaleString()} chars`,
          });
        }
        await loadDocs();
        setTimeout(() => setUploadProgress(null), 4_000);
      } catch (err) {
        setUploadProgress({ filename: file.name, status: `error: ${(err as Error).message}` });
      }
    },
    [loadDocs],
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const files = e.dataTransfer?.files;
      if (!files || files.length === 0) return;
      // Upload sequentially so progress readout stays coherent. Parallel
      // uploads race the brain_documents.sha256 unique constraint and one
      // loses; serial keeps output clean and doesn't starve Postgres.
      (async () => {
        for (const f of Array.from(files)) await uploadFile(f);
      })();
    },
    [uploadFile],
  );

  const runQuery = useCallback(async () => {
    const q = queryText.trim();
    if (!q) return;
    setQuerying(true);
    try {
      const res = await fetchWithRefresh("/api/brain/query", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ query: q, limit: 8 }),
      });
      if (res.ok) {
        setQueryResult((await res.json()) as QueryResponse);
      } else {
        setQueryResult(null);
      }
    } finally {
      setQuerying(false);
    }
  }, [queryText]);

  const indexedCount = useMemo(() => docs.filter((d) => d.status === "indexed").length, [docs]);
  const totalChunks = useMemo(() => docs.reduce((s, d) => s + d.chunk_count, 0), [docs]);

  return (
    <div style={{ padding: "1.5rem", display: "flex", flexDirection: "column", gap: "1.5rem" }}>
      <header>
        <h1 style={{ margin: 0 }}>Central Brain</h1>
        <p style={{ color: "var(--wp-muted)", marginTop: "0.25rem" }}>
          Drop in docs, transcripts, CSVs, or anything the team should be able to ask the
          assistant about. {indexedCount} documents indexed · {totalChunks.toLocaleString()} chunks.
        </p>
      </header>

      {/* Dropzone */}
      <section
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        onClick={() => fileInputRef.current?.click()}
        style={{
          background: dragOver ? "var(--wp-card-hover, var(--wp-card))" : "var(--wp-card)",
          border: `2px dashed ${dragOver ? "var(--wp-gold)" : "var(--wp-border)"}`,
          borderRadius: "8px",
          padding: "2rem",
          textAlign: "center",
          cursor: "pointer",
          transition: "all 0.15s ease",
        }}
      >
        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            const files = Array.from(e.target.files || []);
            (async () => {
              for (const f of files) await uploadFile(f);
            })();
            e.target.value = "";
          }}
        />
        <div style={{ fontSize: "1.2rem", fontWeight: 600 }}>Drop files to add to the Brain</div>
        <div style={{ color: "var(--wp-muted)", marginTop: "0.5rem", fontSize: "0.9rem" }}>
          PDF, Word, text, markdown, CSV, HTML — more types coming. Up to 25 MB per file.
        </div>
        {uploadProgress && (
          <div
            data-testid="upload-progress"
            style={{
              marginTop: "1rem",
              padding: "0.75rem",
              background: "var(--wp-card-hover, var(--wp-card))",
              borderRadius: "6px",
              fontSize: "0.9rem",
            }}
          >
            <strong>{uploadProgress.filename}</strong> — {uploadProgress.status}
          </div>
        )}
      </section>

      {/* Query */}
      <section
        style={{
          background: "var(--wp-card)",
          border: "1px solid var(--wp-border)",
          borderRadius: "8px",
          padding: "1.25rem",
        }}
      >
        <h2 style={{ marginTop: 0, fontSize: "1.1rem" }}>Ask the Brain</h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            runQuery();
          }}
          style={{ display: "flex", gap: "0.5rem" }}
        >
          <input
            type="text"
            value={queryText}
            onChange={(e) => setQueryText(e.target.value)}
            placeholder="e.g. How do we handle a dealer escalation?"
            style={{
              flex: 1,
              padding: "0.6rem 0.9rem",
              borderRadius: "6px",
              border: "1px solid var(--wp-border)",
              background: "var(--wp-input-bg, var(--wp-card))",
              color: "var(--wp-text)",
            }}
          />
          <button
            type="submit"
            disabled={querying || !queryText.trim()}
            style={{
              padding: "0.6rem 1.2rem",
              background: "var(--wp-gold)",
              color: "var(--wp-dark)",
              border: "none",
              borderRadius: "6px",
              fontWeight: 600,
              cursor: querying ? "not-allowed" : "pointer",
              opacity: querying ? 0.6 : 1,
            }}
          >
            {querying ? "Searching…" : "Search"}
          </button>
        </form>
        {queryResult && (
          <div data-testid="query-result" style={{ marginTop: "1rem" }}>
            <div style={{ color: "var(--wp-muted)", fontSize: "0.85rem", marginBottom: "0.5rem" }}>
              {queryResult.hits.length} hits · {queryResult.keyword_hits} keyword ·{" "}
              {queryResult.semantic_hits} semantic · {queryResult.latency_ms} ms
            </div>
            {queryResult.hits.length === 0 ? (
              <div style={{ color: "var(--wp-muted)" }}>No matches yet. Try different words or upload more docs.</div>
            ) : (
              <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                {queryResult.hits.map((h) => (
                  <li
                    key={h.chunk_id}
                    style={{
                      background: "var(--wp-card-hover, var(--wp-card))",
                      padding: "0.75rem",
                      borderRadius: "6px",
                      borderLeft: "3px solid var(--wp-gold)",
                    }}
                  >
                    <div style={{ fontWeight: 600, fontSize: "0.95rem" }}>
                      {h.document_filename} <span style={{ color: "var(--wp-muted)", fontWeight: 400, fontSize: "0.8rem" }}>#{h.chunk_idx}</span>
                    </div>
                    <div
                      style={{ fontSize: "0.9rem", marginTop: "0.25rem" }}
                      dangerouslySetInnerHTML={{ __html: h.snippet }}
                    />
                    <div style={{ fontSize: "0.75rem", color: "var(--wp-muted)", marginTop: "0.25rem" }}>
                      {h.source} · score {h.score.toFixed(2)}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>

      {/* Library */}
      <section>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.75rem" }}>
          <h2 style={{ margin: 0, fontSize: "1.1rem" }}>Library</h2>
          <div style={{ display: "flex", gap: "0.5rem" }}>
            {(["mine", "all"] as const).map((k) => (
              <button
                key={k}
                onClick={() => setFilter(k)}
                style={{
                  padding: "0.35rem 0.8rem",
                  background: filter === k ? "var(--wp-gold)" : "var(--wp-card)",
                  color: filter === k ? "var(--wp-dark)" : "var(--wp-text)",
                  border: "1px solid var(--wp-border)",
                  borderRadius: "6px",
                  cursor: "pointer",
                  fontSize: "0.85rem",
                }}
              >
                {k === "mine" ? "Mine" : "All"}
              </button>
            ))}
          </div>
        </div>

        {loading && <div style={{ color: "var(--wp-muted)" }}>Loading…</div>}
        {!loading && docs.length === 0 && (
          <div style={{ color: "var(--wp-muted)" }}>
            Nothing here yet. Drop a file above to add the first document.
          </div>
        )}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
            gap: "0.75rem",
          }}
        >
          {docs.map((d) => (
            <article
              key={d.id}
              data-testid="doc-card"
              style={{
                background: "var(--wp-card)",
                border: "1px solid var(--wp-border)",
                borderRadius: "8px",
                padding: "0.9rem",
                display: "flex",
                flexDirection: "column",
                gap: "0.4rem",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "start", gap: "0.5rem" }}>
                <div style={{ fontWeight: 600, fontSize: "0.95rem", wordBreak: "break-word" }}>{d.filename}</div>
                <span
                  style={{
                    fontSize: "0.7rem",
                    padding: "0.15rem 0.5rem",
                    borderRadius: "999px",
                    background: STATUS_COLORS[d.status] || "var(--wp-muted)",
                    color: "var(--wp-dark)",
                    flexShrink: 0,
                  }}
                >
                  {d.status}
                </span>
              </div>
              <div style={{ fontSize: "0.8rem", color: "var(--wp-muted)" }}>
                {d.kind} · {formatBytes(d.size_bytes)} · {d.chunk_count} chunks
              </div>
              {d.status_detail && (
                <div style={{ fontSize: "0.75rem", color: "var(--wp-muted)", fontStyle: "italic" }}>
                  {d.status_detail}
                </div>
              )}
              {d.tags.length > 0 && (
                <div style={{ display: "flex", gap: "0.25rem", flexWrap: "wrap" }}>
                  {d.tags.map((t) => (
                    <span
                      key={t}
                      style={{
                        fontSize: "0.7rem",
                        padding: "0.1rem 0.4rem",
                        borderRadius: "999px",
                        background: "var(--wp-tag-bg, var(--wp-card-hover, var(--wp-card)))",
                        border: "1px solid var(--wp-border)",
                      }}
                    >
                      {t}
                    </span>
                  ))}
                </div>
              )}
              <div style={{ fontSize: "0.7rem", color: "var(--wp-muted)", marginTop: "auto" }}>
                {new Date(d.created_at).toLocaleDateString()} · {d.uploaded_by}
              </div>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
