"use client";

import { useState, useEffect } from "react";
import { jsonHeaders } from "@/lib/client-auth";

interface TimelineEvent {
  time: string;
  description: string;
  type: string;
}

interface JournalData {
  id: string;
  user_id: string;
  date: string;
  content: string;
  auto_context: Record<string, unknown>;
  mood: string | null;
  highlights: string[];
  blockers: string[];
}

const MOOD_OPTIONS = [
  { value: "productive", label: "Productive", color: "var(--wp-success)" },
  { value: "neutral", label: "Neutral", color: "var(--wp-text-dim)" },
  { value: "blocked", label: "Blocked", color: "var(--wp-error)" },
  { value: "creative", label: "Creative", color: "var(--wp-gold)" },
];

function formatTime(ts: string): string {
  try {
    return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return ts;
  }
}

// Events that should be visible to users (everything else is hidden)
const EVENT_DESCRIPTIONS: Record<string, (meta: Record<string, unknown>) => string> = {
  "knowledge.question_asked": (m) => `Asked: ${(m.question as string) || "a question"}`,
  "knowledge.answer_found": () => "Got an answer from the knowledge base",
  "knowledge.answer_rated": (m) => `Rated an answer ${m.rating === 5 ? "helpful" : "not helpful"}`,
  "knowledge.doc_generated": (m) => `Generated ${(m.doc_type as string) || "a document"}`,
  "knowledge.doc_downloaded": () => "Downloaded a document",
  "feature.request_submitted": (m) => `Submitted feature request: ${(m.title as string) || ""}`,
  "feature.request_analyzed": () => "Feature request analyzed",
  "discussion.thread_created": (m) => `Started discussion: ${(m.title as string) || ""}`,
  "discussion.reply_posted": () => "Replied to a discussion",
  "discussion.resolved": () => "Resolved a discussion",
  "system.login": () => "Logged in",
  "system.page_viewed": (m) => `Viewed ${(m.page as string) || "a page"}`,
  "system.search_performed": (m) => `Searched ${(m.module as string) || "the platform"}`,
  "journal.entry_created": () => "Journal auto-saved",
  "journal.entry_updated": () => "Updated journal",
  "client.doc_generated": () => "Generated a client document",
  "client.email_drafted": () => "Drafted a client email",
  "client.proposal_created": () => "Created a client proposal",
  "assistant.file_attached": (m) => `Attached file: ${(m.file_name as string) || "a file"}`,
  "assistant.doc_ingested": (m) => `Added to knowledge base: ${(m.file_name as string) || "a document"}`,
};

// Internal events hidden from the timeline (system noise)
const HIDDEN_EVENTS = new Set([
  "knowledge.answer_not_found",
  "system.ai_call_made",
  "system.ai_call_skipped",
  "system.analytics_queried",
  "assistant.doc_quality_checked",
  "assistant.doc_rejected",
]);

export default function JournalPage() {
  const [journal, setJournal] = useState<JournalData | null>(null);
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedDate, setSelectedDate] = useState(new Date().toISOString().slice(0, 10));
  const [note, setNote] = useState("");
  const [mood, setMood] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState("");

  function authHeaders(): HeadersInit {
    return jsonHeaders();
  }

  useEffect(() => {
    fetchJournal();
    fetch("/api/analytics", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ event: "system.page_viewed", metadata: { page: "journal" } }),
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDate]);

  async function fetchJournal() {
    setLoading(true);
    try {
      const res = await fetch(`/api/journal?date=${selectedDate}`, {
        headers: authHeaders(),
      });
      const data = await res.json();
      const j = data.journal;
      setJournal(j);
      setNote(j?.content || "");
      setMood(j?.mood || null);

      // Build timeline from auto_context events
      const autoEvents = (j?.auto_context?.events || []) as Array<{
        event_type: string;
        timestamp: string;
        metadata?: Record<string, unknown>;
      }>;
      // Filter hidden events, map to descriptions, and deduplicate
      const mapped = autoEvents
        .filter((ev) => !HIDDEN_EVENTS.has(ev.event_type))
        .filter((ev) => EVENT_DESCRIPTIONS[ev.event_type]) // only show events we have descriptions for
        .map((ev) => {
          const descFn = EVENT_DESCRIPTIONS[ev.event_type];
          const meta = ev.metadata || {};
          return {
            time: formatTime(ev.timestamp),
            description: descFn(meta),
            type: ev.event_type,
          };
        });

      // Deduplicate consecutive identical events (e.g. multiple logins)
      const timeline: TimelineEvent[] = [];
      for (const ev of mapped) {
        const prev = timeline[timeline.length - 1];
        if (prev && prev.description === ev.description && prev.time === ev.time) {
          continue; // skip duplicate
        }
        timeline.push(ev);
      }

      // If no auto events, show demo timeline in shadow mode
      if (timeline.length === 0 && data.journal) {
        const now = new Date();
        timeline.push(
          {
            time: new Date(now.getTime() - 3600_000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
            description: "Logged in",
            type: "system.login",
          },
          {
            time: new Date(now.getTime() - 2400_000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
            description: "Asked: How does the pricing engine work?",
            type: "knowledge.question_asked",
          },
          {
            time: new Date(now.getTime() - 1200_000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
            description: "Generated API doc for auth.ts",
            type: "knowledge.doc_generated",
          },
          {
            time: new Date(now.getTime() - 600_000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
            description: "Submitted feature request: Add bulk import",
            type: "feature.request_submitted",
          },
        );
      }
      setEvents(timeline);
    } catch {
      setJournal(null);
      setEvents([]);
    }
    setLoading(false);
  }

  async function handleSave() {
    if (!journal) return;
    setSaving(true);
    setSaveMsg("");
    try {
      const res = await fetch("/api/journal", {
        method: "PUT",
        headers: authHeaders(),
        body: JSON.stringify({
          journal_id: journal.id,
          content: note,
          mood,
        }),
      });
      if (res.ok) {
        setSaveMsg("Saved");
        setTimeout(() => setSaveMsg(""), 2000);
      } else {
        setSaveMsg("Failed to save");
      }
    } catch {
      setSaveMsg("Failed to save");
    }
    setSaving(false);
  }

  const TYPE_COLORS: Record<string, string> = {
    "knowledge.question_asked": "var(--wp-info)",
    "knowledge.answer_found": "var(--wp-success)",
    "knowledge.answer_rated": "var(--wp-gold)",
    "knowledge.doc_generated": "var(--wp-success)",
    "knowledge.doc_downloaded": "var(--wp-success)",
    "feature.request_submitted": "var(--wp-warning)",
    "feature.request_analyzed": "var(--wp-warning)",
    "discussion.thread_created": "var(--wp-gold)",
    "discussion.reply_posted": "var(--wp-gold)",
    "discussion.resolved": "var(--wp-success)",
    "client.doc_generated": "var(--wp-success)",
    "client.email_drafted": "var(--wp-info)",
    "client.proposal_created": "var(--wp-info)",
    "assistant.file_attached": "var(--wp-info)",
    "assistant.doc_ingested": "var(--wp-success)",
    "journal.entry_created": "var(--wp-text-muted)",
    "journal.entry_updated": "var(--wp-text-muted)",
    "system.login": "var(--wp-text-dim)",
    "system.page_viewed": "var(--wp-text-muted)",
    "system.search_performed": "var(--wp-info)",
  };

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <h1 className="text-2xl font-bold" style={{ color: "var(--wp-gold)" }}>
          Journal
        </h1>
        <input
          type="date"
          value={selectedDate}
          onChange={(e) => setSelectedDate(e.target.value)}
          className="rounded-lg border px-3 py-2 text-sm outline-none"
          style={{
            background: "var(--wp-dark-surface)",
            borderColor: "var(--wp-dark-border)",
            color: "var(--wp-text)",
            colorScheme: "dark",
          }}
        />
      </div>

      {/* Mood Selector */}
      <div
        className="rounded-lg border p-4"
        style={{ background: "var(--wp-dark-surface)", borderColor: "var(--wp-dark-border)" }}
      >
        <p className="text-sm font-medium mb-3" style={{ color: "var(--wp-text-dim)" }}>
          How are you feeling today?
        </p>
        <div className="flex gap-2 flex-wrap">
          {MOOD_OPTIONS.map((m) => (
            <button
              key={m.value}
              onClick={() => setMood(mood === m.value ? null : m.value)}
              className="px-4 py-2 rounded-lg text-sm font-medium transition-colors border"
              style={{
                background: mood === m.value ? `${m.color}20` : "var(--wp-dark-surface2)",
                borderColor: mood === m.value ? m.color : "var(--wp-dark-border)",
                color: mood === m.value ? m.color : "var(--wp-text-dim)",
              }}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      {/* Timeline */}
      {loading ? (
        <p className="text-sm" style={{ color: "var(--wp-text-dim)" }}>Loading journal...</p>
      ) : (
        <div
          className="rounded-lg border p-5"
          style={{ background: "var(--wp-dark-surface)", borderColor: "var(--wp-dark-border)" }}
        >
          <h2 className="text-sm font-semibold mb-4" style={{ color: "var(--wp-gold)" }}>
            Activity Timeline
          </h2>
          {events.length === 0 ? (
            <p className="text-sm" style={{ color: "var(--wp-text-muted)" }}>
              No activity recorded for this date.
            </p>
          ) : (
            <div className="space-y-0">
              {events.map((ev, i) => (
                <div key={i} className="flex gap-4 relative">
                  {/* Timeline line */}
                  <div className="flex flex-col items-center">
                    <div
                      className="w-2.5 h-2.5 rounded-full shrink-0 mt-1.5"
                      style={{ background: TYPE_COLORS[ev.type] || "var(--wp-text-dim)" }}
                    />
                    {i < events.length - 1 && (
                      <div
                        className="w-px flex-1 min-h-[24px]"
                        style={{ background: "var(--wp-dark-border)" }}
                      />
                    )}
                  </div>
                  <div className="pb-4">
                    <span className="text-xs font-mono" style={{ color: "var(--wp-text-muted)" }}>
                      {ev.time}
                    </span>
                    <p className="text-sm mt-0.5">{ev.description}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Manual Note */}
      <div
        className="rounded-lg border p-5"
        style={{ background: "var(--wp-dark-surface)", borderColor: "var(--wp-dark-border)" }}
      >
        <h2 className="text-sm font-semibold mb-3" style={{ color: "var(--wp-gold)" }}>
          Add a Note
        </h2>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Add context about your day..."
          rows={4}
          className="w-full rounded-lg border px-4 py-3 text-sm outline-none resize-none"
          style={{
            background: "var(--wp-dark-surface2)",
            borderColor: "var(--wp-dark-border)",
            color: "var(--wp-text)",
          }}
        />
        <div className="flex items-center gap-3 mt-3">
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-2 rounded-lg text-sm font-semibold transition-colors disabled:opacity-50"
            style={{ background: "var(--wp-gold)", color: "var(--wp-dark)" }}
          >
            {saving ? "Saving..." : "Save Note"}
          </button>
          {saveMsg && (
            <span
              className="text-sm"
              style={{ color: saveMsg === "Saved" ? "var(--wp-success)" : "var(--wp-error)" }}
            >
              {saveMsg}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
