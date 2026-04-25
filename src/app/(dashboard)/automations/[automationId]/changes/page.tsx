"use client";

/**
 * /automations/[automationId]/changes — Mon/Fri-style digest.
 *
 * One row per class_key in the active window, showing the LATEST delta.
 * "Copy digest" copies a plain-text summary to the clipboard so the program owner
 * can paste it straight into a sync email.
 */

import { useEffect, useState, use } from "react";
import Link from "next/link";
import { fetchWithRefresh } from "@/lib/client-auth";

interface DigestRow {
  class_key: string;
  course_type: string;
  class_date: string;
  location: string;
  last_captured_at: string;
  added: string[];
  dropped: string[];
  net_change: number;
  is_baseline: boolean;
  delta_created_at: string;
}

export default function ChangesPage({
  params,
}: {
  params: Promise<{ automationId: string }>;
}) {
  const { automationId } = use(params);
  const [rows, setRows] = useState<DigestRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const r = await fetchWithRefresh(
          `/api/automations/${automationId}/changes`,
        );
        if (!r.ok) {
          setError(`Failed to load changes (${r.status})`);
          return;
        }
        const data = (await r.json()) as { classes: DigestRow[] };
        setRows(data.classes ?? []);
      } catch (err) {
        setError(`Network error: ${(err as Error).message}`);
      } finally {
        setLoading(false);
      }
    })();
  }, [automationId]);

  function digestText(): string {
    if (rows.length === 0) return "No changes in window.";
    const lines: string[] = [];
    lines.push(`Porsche BA101/102 changes — ${new Date().toLocaleDateString()}`);
    lines.push("");
    for (const r of rows) {
      const heading = `${r.course_type} · ${r.class_date} · ${r.location}`;
      lines.push(heading);
      if (r.is_baseline) {
        lines.push(`  • baseline · ${r.added.length} initial registrations`);
      } else {
        if (r.added.length > 0) lines.push(`  + ${r.added.join(", ")}`);
        if (r.dropped.length > 0) lines.push(`  - ${r.dropped.join(", ")}`);
        if (r.added.length === 0 && r.dropped.length === 0) {
          lines.push(`  • no change since last snapshot`);
        }
      }
      lines.push("");
    }
    return lines.join("\n");
  }

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(digestText());
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Older browsers / iframe contexts may block clipboard. Surface a
      // visible textarea fallback.
      const t = document.createElement("textarea");
      t.value = digestText();
      document.body.appendChild(t);
      t.select();
      try {
        document.execCommand("copy");
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } finally {
        document.body.removeChild(t);
      }
    }
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
        }}
      >
        <h1 style={{ fontSize: "1.6rem", margin: 0 }}>Changes</h1>
        <button
          onClick={handleCopy}
          data-testid="copy-digest"
          style={{
            background: "var(--wp-gold)",
            color: "var(--wp-dark)",
            border: "none",
            padding: "0.5rem 1rem",
            borderRadius: "6px",
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          {copied ? "Copied!" : "Copy digest"}
        </button>
      </div>

      {loading && <div style={{ color: "var(--wp-text-dim)" }}>Loading…</div>}
      {error && <div style={{ color: "#c44" }}>{error}</div>}

      {!loading && !error && rows.length === 0 && (
        <div
          style={{
            padding: "2rem",
            textAlign: "center",
            border: "1px dashed var(--wp-border)",
            borderRadius: "8px",
            color: "var(--wp-text-dim)",
          }}
          data-testid="changes-empty"
        >
          No deltas yet. Run the inbox poller from the overview page to
          ingest the latest report.
        </div>
      )}

      {!loading && rows.length > 0 && (
        <div style={{ display: "grid", gap: "0.75rem" }} data-testid="changes-list">
          {rows.map((r) => (
            <div
              key={r.class_key}
              data-testid={`change-row-${r.class_key}`}
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
                <div style={{ fontWeight: 600 }}>
                  {r.course_type} · {r.class_date}
                </div>
                <div
                  style={{
                    fontSize: "0.8rem",
                    color:
                      r.net_change > 0
                        ? "var(--wp-success)"
                        : r.net_change < 0
                          ? "#c44"
                          : "var(--wp-text-dim)",
                    fontWeight: 600,
                  }}
                >
                  {r.is_baseline
                    ? `BASELINE (+${r.added.length})`
                    : `${r.net_change > 0 ? "+" : ""}${r.net_change}`}
                </div>
              </div>
              <div
                style={{
                  fontSize: "0.85rem",
                  color: "var(--wp-text-dim)",
                  marginTop: "0.2rem",
                }}
              >
                {r.location}
              </div>
              {r.added.length > 0 && (
                <div style={{ marginTop: "0.5rem", fontSize: "0.85rem" }}>
                  <strong style={{ color: "var(--wp-success)" }}>
                    Added:
                  </strong>{" "}
                  {r.added.join(", ")}
                </div>
              )}
              {r.dropped.length > 0 && (
                <div style={{ marginTop: "0.3rem", fontSize: "0.85rem" }}>
                  <strong style={{ color: "#c44" }}>Dropped:</strong>{" "}
                  {r.dropped.join(", ")}
                </div>
              )}
              <div
                style={{
                  fontSize: "0.7rem",
                  color: "var(--wp-text-dim)",
                  marginTop: "0.6rem",
                  letterSpacing: "0.05em",
                }}
              >
                Last snapshot: {new Date(r.last_captured_at).toLocaleString()}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
