"use client";

/**
 * /automations/[automationId]/summaries — class summary index.
 *
 * Lists every class with at least one snapshot inside the automation's
 * active window. Each row links to the per-class summary page, which
 * renders the assembled draft (registration roster + coordinator notes
 * + instructor notes + survey rollup) for copy-into-the-Word-template.
 *
 * Reuses the /changes endpoint since it already returns the canonical
 * (class_key, course_type, class_date, location, last_captured_at)
 * tuple per class. No new API.
 */

import { useEffect, useState, use } from "react";
import Link from "next/link";
import { fetchWithRefresh } from "@/lib/client-auth";

interface ClassRow {
  class_key: string;
  course_type: string;
  class_date: string;
  location: string;
  last_captured_at: string;
}

export default function SummariesIndexPage({
  params,
}: {
  params: Promise<{ automationId: string }>;
}) {
  const { automationId } = use(params);
  const [rows, setRows] = useState<ClassRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const r = await fetchWithRefresh(
          `/api/automations/${encodeURIComponent(automationId)}/changes`,
        );
        if (!r.ok) {
          if (!cancelled) setError(`Failed to load classes (${r.status})`);
          return;
        }
        const data = (await r.json()) as { classes: ClassRow[] };
        if (!cancelled) {
          setRows(
            (data.classes ?? []).slice().sort((a, b) => {
              // Earliest upcoming class first.
              return a.class_date.localeCompare(b.class_date);
            }),
          );
          setError(null);
        }
      } catch (err) {
        if (!cancelled)
          setError(`Network error: ${(err as Error).message}`);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [automationId]);

  return (
    <div style={{ padding: "2rem", color: "var(--wp-text)" }}>
      <Link
        href={`/automations/${automationId}`}
        style={{
          fontSize: "0.8rem",
          color: "var(--wp-text-dim)",
          textDecoration: "none",
          display: "inline-block",
          padding: "0.6rem 0.5rem",
          margin: "-0.6rem -0.5rem",
          touchAction: "manipulation",
        }}
      >
        ← Back to automation
      </Link>
      <h1 style={{ fontSize: "1.8rem", margin: "0.3rem 0 0.4rem" }}>
        Class summaries
      </h1>
      <p
        style={{
          color: "var(--wp-text-dim)",
          marginTop: 0,
          marginBottom: "1.5rem",
          maxWidth: "60ch",
          lineHeight: 1.4,
        }}
      >
        Pick a class to see the assembled summary draft (registration
        roster + coordinator and instructor notes + survey rollup). Use
        Copy as plain text or Download JSON to drop into the Word
        template.
      </p>

      {loading && (
        <div style={{ color: "var(--wp-text-dim)" }}>Loading classes…</div>
      )}
      {error && (
        <div
          style={{
            padding: "0.7rem 0.9rem",
            background: "rgba(204,68,68,0.10)",
            border: "1px solid #c44",
            borderLeftWidth: "4px",
            borderRadius: "6px",
            color: "var(--wp-text)",
          }}
        >
          {error}
        </div>
      )}
      {!loading && !error && rows.length === 0 && (
        <div
          data-testid="summaries-empty"
          style={{
            padding: "1.2rem",
            background: "var(--wp-card)",
            border: "1px solid var(--wp-border)",
            borderRadius: "8px",
            color: "var(--wp-text-dim)",
            maxWidth: "640px",
          }}
        >
          No classes with snapshots yet. Once a Porsche daily report is
          ingested (manually via Run now or automatically by the cron),
          the matched classes will appear here.
        </div>
      )}
      {!loading && !error && rows.length > 0 && (
        <div
          data-testid="summaries-list"
          style={{ display: "grid", gap: "0.6rem", maxWidth: "780px" }}
        >
          {rows.map((c) => (
            <Link
              key={c.class_key}
              href={`/automations/${encodeURIComponent(automationId)}/summaries/${encodeURIComponent(c.class_key)}`}
              data-testid={`summary-link-${c.class_key}`}
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: "1rem",
                padding: "0.9rem 1rem",
                background: "var(--wp-card)",
                border: "1px solid var(--wp-border)",
                borderRadius: "6px",
                textDecoration: "none",
                color: "var(--wp-text)",
                transition: "border-color 120ms",
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: "0.95rem" }}>
                  {c.course_type} · {formatDate(c.class_date)}
                </div>
                <div
                  style={{
                    color: "var(--wp-text-dim)",
                    fontSize: "0.82rem",
                    marginTop: "0.2rem",
                  }}
                >
                  {c.location} · last update {formatTime(c.last_captured_at)}
                </div>
              </div>
              <span
                aria-hidden="true"
                style={{ color: "var(--wp-text-dim)", fontSize: "1.1rem" }}
              >
                ›
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

function formatDate(iso: string): string {
  if (!iso) return "—";
  const d = new Date(`${iso}T12:00:00Z`);
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatTime(iso: string): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
