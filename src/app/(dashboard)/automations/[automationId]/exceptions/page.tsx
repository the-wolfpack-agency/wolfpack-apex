"use client";

/**
 * /automations/[automationId]/exceptions — exception queue.
 *
 * Each row: kind, detail, "Open artifact" (downloads the original
 * eml/xlsx via the artifacts route), "Resolve" / "Dismiss" buttons.
 *
 * The artifact download link uses fetchWithRefresh to authenticate the
 * GET request, then turns the response blob into an object URL the
 * browser triggers a download for.
 */

import { useEffect, useState, use } from "react";
import Link from "next/link";
import { fetchWithRefresh } from "@/lib/client-auth";

interface ExceptionRow {
  id: string;
  automation_id: string;
  artifact_id: string;
  kind: string;
  detail: string;
  status: "open" | "resolved" | "dismissed";
  resolved_by: string | null;
  resolved_at: string | null;
  created_at: string;
}

const STATUS_OPTIONS = [
  { value: "open", label: "Open" },
  { value: "resolved", label: "Resolved" },
  { value: "dismissed", label: "Dismissed" },
  { value: "all", label: "All" },
];

export default function ExceptionsPage({
  params,
}: {
  params: Promise<{ automationId: string }>;
}) {
  const { automationId } = use(params);
  const [rows, setRows] = useState<ExceptionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>("open");
  const [busyId, setBusyId] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      const r = await fetchWithRefresh(
        `/api/automations/${automationId}/exceptions?status=${encodeURIComponent(statusFilter)}`,
      );
      if (!r.ok) {
        setError(`Failed to load exceptions (${r.status})`);
        return;
      }
      const data = (await r.json()) as { exceptions: ExceptionRow[] };
      setRows(data.exceptions ?? []);
      setError(null);
    } catch (err) {
      setError(`Network error: ${(err as Error).message}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [automationId, statusFilter]);

  async function handleResolve(id: string, outcome: "resolved" | "dismissed") {
    setBusyId(id);
    try {
      const r = await fetchWithRefresh(
        `/api/automations/${automationId}/exceptions/${id}/resolve`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ outcome }),
        },
      );
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        setError(`Failed (${r.status}): ${data.error ?? ""}`);
        return;
      }
      await load();
    } finally {
      setBusyId(null);
    }
  }

  async function handleDownload(artifactId: string) {
    const r = await fetchWithRefresh(
      `/api/automations/${automationId}/artifacts/${artifactId}`,
    );
    if (!r.ok) {
      setError(`Failed to download artifact (${r.status})`);
      return;
    }
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `artifact-${artifactId}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return (
    <div style={{ padding: "2rem", color: "var(--wp-text)" }}>
      <Link
        href={`/automations/${automationId}`}
        style={{ fontSize: "0.8rem", color: "var(--wp-text-dim)", textDecoration: "none" }}
      >
        ← Overview
      </Link>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          margin: "0.3rem 0 1.5rem 0",
          gap: "1rem",
          flexWrap: "wrap",
        }}
      >
        <h1 style={{ fontSize: "1.6rem", margin: 0 }}>Exceptions</h1>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          data-testid="exceptions-status-filter"
          style={{
            background: "var(--wp-card)",
            color: "var(--wp-text)",
            border: "1px solid var(--wp-border)",
            padding: "0.4rem 0.6rem",
            borderRadius: "6px",
          }}
        >
          {STATUS_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      {loading && <div style={{ color: "var(--wp-text-dim)" }}>Loading…</div>}
      {error && <div style={{ color: "#c44" }}>{error}</div>}

      {!loading && rows.length === 0 && (
        <div
          style={{
            padding: "2rem",
            textAlign: "center",
            border: "1px dashed var(--wp-border)",
            borderRadius: "8px",
            color: "var(--wp-text-dim)",
          }}
          data-testid="exceptions-empty"
        >
          {statusFilter === "open"
            ? "Nothing to review — every artifact ingested cleanly."
            : "No exceptions match this filter."}
        </div>
      )}

      {!loading && rows.length > 0 && (
        <div style={{ display: "grid", gap: "0.75rem" }} data-testid="exceptions-list">
          {rows.map((r) => (
            <div
              key={r.id}
              data-testid={`exception-row-${r.id}`}
              style={{
                padding: "1rem 1.25rem",
                background: "var(--wp-card)",
                border: "1px solid var(--wp-border)",
                borderRadius: "8px",
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  flexWrap: "wrap",
                  gap: "0.5rem",
                }}
              >
                <div>
                  <div style={{ fontWeight: 600 }}>{prettyKind(r.kind)}</div>
                  <div
                    style={{
                      fontSize: "0.85rem",
                      color: "var(--wp-text-dim)",
                      marginTop: "0.2rem",
                      maxWidth: "60ch",
                      lineHeight: 1.4,
                    }}
                  >
                    {r.detail}
                  </div>
                </div>
                <div
                  style={{
                    fontSize: "0.7rem",
                    color: statusColor(r.status),
                    fontWeight: 600,
                    letterSpacing: "0.05em",
                    textTransform: "uppercase",
                  }}
                >
                  {r.status}
                </div>
              </div>
              <div
                style={{
                  display: "flex",
                  gap: "0.5rem",
                  marginTop: "0.8rem",
                  flexWrap: "wrap",
                }}
              >
                <button
                  onClick={() => handleDownload(r.artifact_id)}
                  style={btnStyle}
                  data-testid={`open-artifact-${r.id}`}
                >
                  Open artifact
                </button>
                {r.status === "open" && (
                  <>
                    <button
                      onClick={() => handleResolve(r.id, "resolved")}
                      disabled={busyId === r.id}
                      style={primaryBtnStyle}
                      data-testid={`resolve-${r.id}`}
                    >
                      Resolve
                    </button>
                    <button
                      onClick={() => handleResolve(r.id, "dismissed")}
                      disabled={busyId === r.id}
                      style={btnStyle}
                      data-testid={`dismiss-${r.id}`}
                    >
                      Dismiss
                    </button>
                  </>
                )}
              </div>
              <div
                style={{
                  fontSize: "0.7rem",
                  color: "var(--wp-text-dim)",
                  marginTop: "0.6rem",
                  letterSpacing: "0.05em",
                }}
              >
                Created {new Date(r.created_at).toLocaleString()}
                {r.resolved_by && r.resolved_at
                  ? ` · ${r.status} by ${r.resolved_by} at ${new Date(r.resolved_at).toLocaleString()}`
                  : ""}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function prettyKind(kind: string): string {
  switch (kind) {
    case "parse_failure":
      return "Parse failure";
    case "low_confidence_match":
      return "Low-confidence match";
    case "missing_field":
      return "Missing field";
    case "duplicate_artifact":
      return "Duplicate artifact";
    default:
      return kind;
  }
}

function statusColor(status: string): string {
  switch (status) {
    case "open":
      return "#c44";
    case "resolved":
      return "var(--wp-success)";
    case "dismissed":
      return "var(--wp-text-dim)";
    default:
      return "var(--wp-text-dim)";
  }
}

const btnStyle: React.CSSProperties = {
  background: "transparent",
  color: "var(--wp-text-dim)",
  border: "1px solid var(--wp-border)",
  padding: "0.4rem 0.8rem",
  borderRadius: "6px",
  fontSize: "0.85rem",
  cursor: "pointer",
};

const primaryBtnStyle: React.CSSProperties = {
  background: "var(--wp-gold)",
  color: "var(--wp-dark)",
  border: "none",
  padding: "0.4rem 0.8rem",
  borderRadius: "6px",
  fontSize: "0.85rem",
  fontWeight: 600,
  cursor: "pointer",
};
