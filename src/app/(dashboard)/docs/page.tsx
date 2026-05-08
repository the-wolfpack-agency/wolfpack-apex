"use client";

import { useState, useEffect, FormEvent } from "react";
import { jsonHeaders, fetchWithRefresh } from "@/lib/client-auth";

interface Document {
  id: string;
  title: string;
  doc_type: string;
  content: string;
  format: string;
  generated_from: string | null;
  generated_by: string;
  revision: number;
  tokens_used: number;
  downloads: number;
  created_at: string;
}

const TYPE_COLORS: Record<string, string> = {
  api_doc: "var(--wp-info)",
  feature_doc: "var(--wp-success)",
  release_notes: "var(--wp-warning)",
  client_proposal: "var(--wp-gold)",
};

const TYPE_LABELS: Record<string, string> = {
  api_doc: "API Doc",
  feature_doc: "Feature Doc",
  release_notes: "Release Notes",
  client_proposal: "Client Proposal",
};

export default function DocsPage() {
  const [docs, setDocs] = useState<Document[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Document | null>(null);
  const [showGenerate, setShowGenerate] = useState(false);

  // Generate form
  const [genType, setGenType] = useState("api_doc");
  const [repoPath, setRepoPath] = useState("");
  const [filePath, setFilePath] = useState("");
  const [sinceDate, setSinceDate] = useState("");
  const [featureId, setFeatureId] = useState("");
  const [generating, setGenerating] = useState(false);
  const [genMsg, setGenMsg] = useState("");

  // Edit state for the currently-viewed doc. Routed through
  // fetchWithRefresh to avoid the April 16 raw-fetch bug pattern.
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editContent, setEditContent] = useState("");
  const [editMsg, setEditMsg] = useState("");

  async function saveDocEdit(e: FormEvent) {
    e.preventDefault();
    if (!selected) return;
    setEditMsg("");
    try {
      const res = await fetchWithRefresh(`/api/docs/${selected.id}`, {
        method: "PUT",
        headers: jsonHeaders(),
        body: JSON.stringify({ title: editTitle, content: editContent }),
      });
      if (res.ok) {
        const data = await res.json();
        setEditMsg("Saved");
        setSelected(data.document);
        setEditing(false);
        fetchDocs();
      } else {
        const data = await res.json().catch(() => ({}));
        setEditMsg(data.error ?? "Save failed");
      }
    } catch {
      setEditMsg("Save failed");
    }
  }

  async function deleteDoc() {
    if (!selected) return;
    const ok =
      typeof window !== "undefined"
        ? window.confirm(`Delete document "${selected.title}"?`)
        : false;
    if (!ok) return;
    try {
      const res = await fetchWithRefresh(`/api/docs/${selected.id}`, {
        method: "DELETE",
        headers: authHeaders(),
      });
      if (res.ok) {
        setSelected(null);
        fetchDocs();
      }
    } catch {
      // silent
    }
  }

  function authHeaders(): HeadersInit {
    return jsonHeaders();
  }

  useEffect(() => {
    fetchDocs();
    fetchWithRefresh("/api/analytics", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ event: "system.page_viewed", metadata: { page: "docs" } }),
    }).catch(() => {});
    /* Removed (security): the URL-controlled `?generate=1` deeplink
       branched control flow on user-controlled input, which CodeQL
       flagged as js/user-controlled-bypass. The Generate panel is
       always reachable via the "Generate Doc" button; there is no
       separate behavior for the deeplink path. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function fetchDocs() {
    setLoading(true);
    try {
      const res = await fetchWithRefresh("/api/docs", { headers: authHeaders() });
      const data = await res.json();
      setDocs(data.documents || []);
    } catch {
      setDocs([]);
    }
    setLoading(false);
  }

  async function handleGenerate(e: FormEvent) {
    e.preventDefault();
    setGenerating(true);
    setGenMsg("");
    try {
      const body: Record<string, unknown> = { type: genType, save: true };
      if (genType === "api_doc") {
        body.repo_path = repoPath;
        body.file_path = filePath;
      } else if (genType === "release_notes") {
        body.repo_path = repoPath;
        body.since_date = sinceDate;
      } else if (genType === "feature_doc") {
        body.feature_request_id = featureId;
      }

      const res = await fetchWithRefresh("/api/docs", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify(body),
      });

      if (res.ok) {
        const data = await res.json();
        setGenMsg("Document generated!");
        setSelected(data.document);
        setShowGenerate(false);
        fetchDocs();
      } else {
        const data = await res.json();
        setGenMsg(data.error || "Failed to generate");
      }
    } catch {
      setGenMsg("Failed to generate");
    }
    setGenerating(false);
  }

  async function handleDownload(doc: Document) {
    fetchWithRefresh(`/api/docs/${doc.id}`, {
      method: "POST",
      headers: authHeaders(),
    }).catch(() => {});

    // Create a downloadable blob
    const blob = new Blob([doc.content], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${doc.title.replace(/[^a-zA-Z0-9]/g, "_")}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // Simple markdown-to-HTML renderer
  function renderMarkdown(md: string): string {
    return md
      .replace(/^### (.*)$/gm, '<h3 class="text-lg font-semibold mt-4 mb-2" style="color:var(--wp-gold)">$1</h3>')
      .replace(/^## (.*)$/gm, '<h2 class="text-xl font-bold mt-6 mb-2" style="color:var(--wp-gold)">$1</h2>')
      .replace(/^# (.*)$/gm, '<h1 class="text-2xl font-bold mt-6 mb-3" style="color:var(--wp-gold)">$1</h1>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code class="text-xs px-1 py-0.5 rounded" style="background:var(--wp-dark-surface2);color:var(--wp-gold)">$1</code>')
      .replace(/^- (.*)$/gm, '<li class="ml-4">$1</li>')
      .replace(/\n/g, "<br>");
  }

  // Document view
  if (selected) {
    return (
      <div className="max-w-4xl mx-auto space-y-6">
        <button
          onClick={() => setSelected(null)}
          className="flex items-center gap-1 text-sm transition-colors"
          style={{ color: "var(--wp-gold)" }}
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
          Back to Documents
        </button>

        <div
          className="rounded-lg border p-6"
          style={{ background: "var(--wp-dark-surface)", borderColor: "var(--wp-dark-border)" }}
        >
          <div className="flex items-start justify-between gap-4 mb-4">
            <div>
              <h1 className="text-xl font-bold">{selected.title}</h1>
              <div className="flex items-center gap-2 mt-1.5">
                <span
                  className="text-xs px-2 py-0.5 rounded font-medium"
                  style={{
                    background: `${TYPE_COLORS[selected.doc_type] || "var(--wp-text-dim)"}20`,
                    color: TYPE_COLORS[selected.doc_type] || "var(--wp-text-dim)",
                  }}
                >
                  {TYPE_LABELS[selected.doc_type] || selected.doc_type}
                </span>
                <span className="text-xs" style={{ color: "var(--wp-text-muted)" }}>
                  Rev {selected.revision} | {selected.downloads} downloads | 0 tokens
                </span>
              </div>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => handleDownload(selected)}
                className="px-4 py-2 rounded-lg text-sm font-semibold transition-colors"
                style={{ background: "var(--wp-gold)", color: "var(--wp-dark)" }}
              >
                Download
              </button>
              <button
                type="button"
                onClick={() => {
                  setEditing(true);
                  setEditTitle(selected.title);
                  setEditContent(selected.content);
                  setEditMsg("");
                }}
                aria-label="Edit document"
                data-testid="doc-edit-btn"
                className="px-3 py-2 rounded-lg text-sm font-medium border"
                style={{
                  background: "var(--wp-dark-surface2)",
                  borderColor: "var(--wp-dark-border)",
                  color: "var(--wp-text)",
                }}
              >
                Edit
              </button>
              <button
                type="button"
                onClick={deleteDoc}
                aria-label="Delete document"
                data-testid="doc-delete-btn"
                className="px-3 py-2 rounded-lg text-sm font-medium border"
                style={{
                  background: "var(--wp-dark-surface2)",
                  borderColor: "var(--wp-dark-border)",
                  color: "var(--wp-error)",
                }}
              >
                Delete
              </button>
            </div>
          </div>
          {editing ? (
            <form
              onSubmit={saveDocEdit}
              className="space-y-3"
              data-testid="doc-edit-form"
            >
              <input
                type="text"
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
                aria-label="Edit document title"
                placeholder="Title"
                required
                className="w-full rounded-lg border px-4 py-2.5 text-sm outline-none"
                style={{
                  background: "var(--wp-dark-surface2)",
                  borderColor: "var(--wp-dark-border)",
                  color: "var(--wp-text)",
                }}
              />
              <textarea
                value={editContent}
                onChange={(e) => setEditContent(e.target.value)}
                aria-label="Edit document content"
                rows={16}
                className="w-full rounded-lg border px-4 py-3 text-sm outline-none resize-y font-mono"
                style={{
                  background: "var(--wp-dark-surface2)",
                  borderColor: "var(--wp-dark-border)",
                  color: "var(--wp-text)",
                }}
              />
              <div className="flex gap-2 items-center">
                <button
                  type="submit"
                  className="px-4 py-2 rounded-lg text-sm font-semibold"
                  style={{ background: "var(--wp-gold)", color: "var(--wp-dark)" }}
                >
                  Save
                </button>
                <button
                  type="button"
                  onClick={() => setEditing(false)}
                  className="px-4 py-2 rounded-lg text-sm font-medium"
                  style={{ color: "var(--wp-text-dim)" }}
                >
                  Cancel
                </button>
                {editMsg && (
                  <span
                    className="text-sm"
                    data-testid="doc-edit-msg"
                    style={{
                      color: editMsg === "Saved" ? "var(--wp-success)" : "var(--wp-error)",
                    }}
                  >
                    {editMsg}
                  </span>
                )}
              </div>
            </form>
          ) : (
            <div
              className="prose prose-invert max-w-none text-sm"
              dangerouslySetInnerHTML={{ __html: renderMarkdown(selected.content) }}
            />
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <h1 className="text-2xl font-bold" style={{ color: "var(--wp-gold)" }}>
          Documents
        </h1>
        <button
          onClick={() => setShowGenerate(!showGenerate)}
          className="px-4 py-2 rounded-lg text-sm font-semibold transition-colors"
          style={{ background: "var(--wp-gold)", color: "var(--wp-dark)" }}
        >
          Generate Doc
        </button>
      </div>

      {genMsg && (
        <div
          className="rounded-lg px-4 py-2.5 text-sm"
          style={{
            background: genMsg.includes("generated") ? "rgba(34,197,94,0.1)" : "rgba(239,68,68,0.1)",
            color: genMsg.includes("generated") ? "var(--wp-success)" : "var(--wp-error)",
          }}
        >
          {genMsg}
        </div>
      )}

      {/* Generate Form */}
      {showGenerate && (
        <div
          className="rounded-lg border p-5"
          style={{ background: "var(--wp-dark-surface)", borderColor: "var(--wp-dark-border)" }}
          data-testid="docs-generate-panel"
        >
          <h3 className="text-sm font-semibold mb-4" style={{ color: "var(--wp-gold)" }}>
            Generate Document
          </h3>
          <form onSubmit={handleGenerate} className="space-y-4">
            <select
              value={genType}
              onChange={(e) => setGenType(e.target.value)}
              className="w-full rounded-lg border px-4 py-2.5 text-sm outline-none"
              style={{
                background: "var(--wp-dark-surface2)",
                borderColor: "var(--wp-dark-border)",
                color: "var(--wp-text)",
              }}
            >
              <option value="api_doc">API Documentation</option>
              <option value="release_notes">Release Notes</option>
              <option value="feature_doc">Feature Documentation</option>
            </select>

            {(genType === "api_doc" || genType === "release_notes") && (
              <input
                type="text"
                value={repoPath}
                onChange={(e) => setRepoPath(e.target.value)}
                placeholder="Repository path (e.g., /path/to/repo)"
                required
                className="w-full rounded-lg border px-4 py-2.5 text-sm outline-none"
                style={{
                  background: "var(--wp-dark-surface2)",
                  borderColor: "var(--wp-dark-border)",
                  color: "var(--wp-text)",
                }}
              />
            )}

            {genType === "api_doc" && (
              <input
                type="text"
                value={filePath}
                onChange={(e) => setFilePath(e.target.value)}
                placeholder="File path (e.g., src/lib/auth.ts)"
                required
                className="w-full rounded-lg border px-4 py-2.5 text-sm outline-none"
                style={{
                  background: "var(--wp-dark-surface2)",
                  borderColor: "var(--wp-dark-border)",
                  color: "var(--wp-text)",
                }}
              />
            )}

            {genType === "release_notes" && (
              <input
                type="date"
                value={sinceDate}
                onChange={(e) => setSinceDate(e.target.value)}
                required
                className="w-full rounded-lg border px-4 py-2.5 text-sm outline-none"
                style={{
                  background: "var(--wp-dark-surface2)",
                  borderColor: "var(--wp-dark-border)",
                  color: "var(--wp-text)",
                  colorScheme: "dark",
                }}
              />
            )}

            {genType === "feature_doc" && (
              <input
                type="text"
                value={featureId}
                onChange={(e) => setFeatureId(e.target.value)}
                placeholder="Feature request ID"
                required
                className="w-full rounded-lg border px-4 py-2.5 text-sm outline-none"
                style={{
                  background: "var(--wp-dark-surface2)",
                  borderColor: "var(--wp-dark-border)",
                  color: "var(--wp-text)",
                }}
              />
            )}

            <div className="flex gap-2">
              <button
                type="submit"
                disabled={generating}
                className="px-4 py-2 rounded-lg text-sm font-semibold transition-colors disabled:opacity-50"
                style={{ background: "var(--wp-gold)", color: "var(--wp-dark)" }}
              >
                {generating ? "Generating..." : "Generate"}
              </button>
              <button
                type="button"
                onClick={() => setShowGenerate(false)}
                className="px-4 py-2 rounded-lg text-sm font-medium"
                style={{ color: "var(--wp-text-dim)" }}
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Doc List */}
      {loading ? (
        <p className="text-sm" style={{ color: "var(--wp-text-dim)" }}>Loading documents...</p>
      ) : docs.length === 0 ? (
        <div
          className="rounded-lg border p-6 space-y-4"
          style={{ background: "var(--wp-dark-surface)", borderColor: "var(--wp-dark-border)" }}
          data-testid="docs-empty-state"
        >
          <div>
            <h2 className="text-lg font-semibold" style={{ color: "var(--wp-gold)" }}>
              No documents yet
            </h2>
            <p className="text-sm mt-1" style={{ color: "var(--wp-text-dim)" }}>
              Generate technical documents straight from your codebase, git
              history, or feature requests. Zero tokens, fully reversible,
              and tied to the learning loop.
            </p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {[
              {
                type: "api_doc",
                label: "API Documentation",
                blurb: "Parse a TypeScript or Python file and produce a markdown reference for every export.",
              },
              {
                type: "release_notes",
                label: "Release Notes",
                blurb: "Group commits since a date by feat/fix/docs/refactor for a clean changelog.",
              },
              {
                type: "feature_doc",
                label: "Feature Documentation",
                blurb: "Render a feature request and its analysis as a stakeholder-ready brief.",
              },
            ].map((card) => (
              <button
                key={card.type}
                type="button"
                data-testid={`docs-empty-card-${card.type}`}
                onClick={() => {
                  setGenType(card.type);
                  setShowGenerate(true);
                }}
                className="text-left rounded-lg border p-4 wp-hover-lift outline-none"
                style={{
                  background: "var(--wp-dark-surface2)",
                  borderColor: "var(--wp-dark-border)",
                }}
              >
                <p className="text-sm font-semibold" style={{ color: "var(--wp-gold)" }}>
                  {card.label}
                </p>
                <p className="text-xs mt-1.5 leading-relaxed" style={{ color: "var(--wp-text-dim)" }}>
                  {card.blurb}
                </p>
              </button>
            ))}
          </div>
          <p className="text-xs" style={{ color: "var(--wp-text-muted)" }}>
            Looking for question-and-answer style notes instead? Try the
            {" "}
            <a
              href="/knowledge"
              style={{ color: "var(--wp-gold)", textDecoration: "underline" }}
            >
              Knowledge Base
            </a>
            .
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {docs.map((doc) => (
            <div
              key={doc.id}
              onClick={() => setSelected(doc)}
              className="rounded-lg border p-4 cursor-pointer wp-hover-lift outline-none"
              style={{ background: "var(--wp-dark-surface)", borderColor: "var(--wp-dark-border)" }}
            >
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">{doc.title}</p>
                  <div className="flex items-center gap-2 mt-1.5">
                    <span
                      className="text-xs px-2 py-0.5 rounded font-medium"
                      style={{
                        background: `${TYPE_COLORS[doc.doc_type] || "var(--wp-text-dim)"}20`,
                        color: TYPE_COLORS[doc.doc_type] || "var(--wp-text-dim)",
                      }}
                    >
                      {TYPE_LABELS[doc.doc_type] || doc.doc_type}
                    </span>
                    <span className="text-xs" style={{ color: "var(--wp-text-muted)" }}>
                      Rev {doc.revision}
                    </span>
                    <span className="text-xs" style={{ color: "var(--wp-text-muted)" }}>
                      {doc.downloads} downloads
                    </span>
                  </div>
                </div>
                <span className="text-xs whitespace-nowrap" style={{ color: "var(--wp-text-muted)" }}>
                  {new Date(doc.created_at).toLocaleDateString()}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
