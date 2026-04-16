"use client";

/**
 * Meetings page — browse ingested Plaud transcripts.
 *
 * Org-shared list view (every team member sees every meeting). Click
 * a row to expand the full transcript inline. The Wolfpack Assistant
 * also draws on this same data via its Priority 3 retrieval, so the
 * Meetings page is the human-facing window onto the same store the
 * Assistant uses behind the scenes.
 */

import { useEffect, useState, useCallback } from "react";
import { authHeaders as canonicalAuthHeaders, fetchWithRefresh } from "@/lib/client-auth";

interface Meeting {
  id: string;
  fileId: string;
  ownerUserId: string;
  ownerName?: string;
  title: string | null;
  summary: string | null;
  recordedAt: string | null;
  durationSeconds: number | null;
  qualityStatus: "pass" | "warn" | "reject";
  ingestedAt: string;
  transcriptText?: string;
}

// Auth headers from canonical client-auth helper

function fmtDate(d: string | null): string {
  if (!d) return "—";
  try {
    return new Date(d).toLocaleString("en-US", {
      month: "short", day: "numeric", year: "numeric",
      hour: "numeric", minute: "2-digit",
    });
  } catch {
    return d;
  }
}

function fmtDuration(s: number | null): string {
  if (!s) return "";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export default function MeetingsPage() {
  const [meetings, setMeetings] = useState<Meeting[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detailCache, setDetailCache] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      const res = await fetchWithRefresh("/api/meetings", {
        headers: canonicalAuthHeaders(),
      });
      if (res.status === 401) {
        window.location.href = "/login";
        return;
      }
      if (!res.ok) {
        setError("Unable to load meetings");
        return;
      }
      const data = await res.json();
      setMeetings(data.transcripts || []);
    } catch {
      setError("Unable to load meetings");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function expand(id: string) {
    if (expandedId === id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(id);
    if (detailCache[id]) return;
    try {
      const res = await fetchWithRefresh(`/api/meetings?id=${encodeURIComponent(id)}`, {
        headers: canonicalAuthHeaders(),
      });
      if (!res.ok) return;
      const data = await res.json();
      if (data.transcript?.transcriptText) {
        setDetailCache((prev) => ({ ...prev, [id]: data.transcript.transcriptText }));
      }
    } catch {
      // Non-fatal
    }
  }

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold" style={{ color: "var(--wp-gold)" }}>Meetings</h1>
        <p className="text-sm mt-1" style={{ color: "var(--wp-text-dim)" }}>
          Recordings ingested from Plaud. Shared across the team.
        </p>
      </div>

      {error && (
        <div
          className="rounded-lg border p-4 text-sm"
          style={{ background: "var(--wp-dark-surface)", borderColor: "var(--wp-error)", color: "var(--wp-error)" }}
        >
          {error}
        </div>
      )}

      {meetings === null && !error && (
        <p className="text-sm" style={{ color: "var(--wp-text-dim)" }}>Loading meetings...</p>
      )}

      {meetings && meetings.length === 0 && (
        <div
          className="rounded-lg border p-6"
          style={{ background: "var(--wp-dark-surface)", borderColor: "var(--wp-dark-border)" }}
        >
          <p className="text-sm" style={{ color: "var(--wp-text-dim)" }}>
            No meeting transcripts yet. Once Plaud is connected and the team records a meeting, transcripts will appear here automatically.
          </p>
          <a
            href="/settings"
            className="inline-block mt-3 text-sm font-medium"
            style={{ color: "var(--wp-gold)" }}
          >
            Go to Settings → Plaud →
          </a>
        </div>
      )}

      {meetings && meetings.length > 0 && (
        <div className="space-y-3">
          {meetings.map((m) => (
            <div
              key={m.id}
              className="rounded-lg border overflow-hidden"
              style={{ background: "var(--wp-dark-surface)", borderColor: "var(--wp-dark-border)" }}
            >
              <button
                onClick={() => expand(m.id)}
                className="w-full text-left p-4 transition-colors hover:opacity-90"
                style={{ background: "transparent" }}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold truncate" style={{ color: "var(--wp-text)" }}>
                      {m.title || "Untitled meeting"}
                    </p>
                    <div className="mt-1 flex items-center gap-3 text-xs" style={{ color: "var(--wp-text-dim)" }}>
                      <span>{fmtDate(m.recordedAt || m.ingestedAt)}</span>
                      {m.durationSeconds ? <span>{fmtDuration(m.durationSeconds)}</span> : null}
                      {m.ownerName ? <span>· {m.ownerName}</span> : null}
                      {m.qualityStatus === "warn" && (
                        <span style={{ color: "var(--wp-warning)" }}>· PII redacted</span>
                      )}
                    </div>
                    {m.summary && (
                      <p className="mt-2 text-sm" style={{ color: "var(--wp-text-dim)" }}>{m.summary}</p>
                    )}
                  </div>
                  <span className="text-xs shrink-0" style={{ color: "var(--wp-text-muted)" }}>
                    {expandedId === m.id ? "▲" : "▼"}
                  </span>
                </div>
              </button>
              {expandedId === m.id && (
                <div
                  className="px-4 pb-4 pt-1 border-t text-sm whitespace-pre-wrap"
                  style={{
                    borderColor: "var(--wp-dark-border)",
                    color: "var(--wp-text)",
                  }}
                >
                  {detailCache[m.id] || (
                    <span style={{ color: "var(--wp-text-dim)" }}>Loading transcript...</span>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
