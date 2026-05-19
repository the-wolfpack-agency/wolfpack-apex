/**
 * MeetingPrepWidget — synthesized cross-source pre-brief, inline in chat.
 *
 * Render-only; the data was synthesized server-side by a single Haiku
 * call (or served from cache). The widget:
 *   - Tags the header with a cache-status pill so the user knows whether
 *     the insight was generated fresh for them or shared from the team
 *     cache.
 *   - Surfaces talking_points, risk_flags (color-coded by severity),
 *     attendee_briefs, and open_questions.
 *   - Each source ref is clickable and emits `assistant.meeting_prep_source_clicked`
 *     so the learning loop sees which references drive engagement.
 *   - "Regenerate" button calls the API route with `force=1`. Server-side
 *     role gate enforces manager+; the button is also hidden client-side
 *     when `viewerCanRegenerate` is false.
 */

"use client";

import { useEffect, useState } from "react";
import { fetchWithRefresh } from "@/lib/client-auth";
import type {
  MeetingPrepWidgetSpec,
  MeetingPrepWidgetSourceRef,
} from "@/lib/assistant/widgets/types";

export interface MeetingPrepWidgetProps {
  spec: MeetingPrepWidgetSpec;
  workflowId?: string;
}

function formatStart(iso: string): string {
  const d = Date.parse(iso);
  if (Number.isNaN(d)) return "";
  const date = new Date(d);
  return date.toLocaleString("default", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function severityColor(s: "low" | "med" | "high"): string {
  switch (s) {
    case "high":
      return "var(--wp-danger, #ef4444)";
    case "med":
      return "var(--wp-warning, #eab308)";
    default:
      return "var(--wp-text-muted, #6b7280)";
  }
}

function emitAnalytics(
  event: string,
  metadata: Record<string, unknown>,
): void {
  fetchWithRefresh("/api/analytics", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event, metadata }),
  }).catch(() => undefined);
}

export function MeetingPrepWidget({ spec, workflowId }: MeetingPrepWidgetProps) {
  const [regenStatus, setRegenStatus] = useState<"idle" | "loading" | "error">(
    "idle",
  );

  useEffect(() => {
    emitAnalytics("assistant.widget_rendered", {
      widget_kind: "meeting_prep",
      meeting_id: spec.meetingId,
      cache_status: spec.cacheStatus,
      synthesis_unavailable: spec.synthesisUnavailable,
      ...(workflowId ? { workflow_id: workflowId } : {}),
    });
  }, [spec.meetingId, spec.cacheStatus, spec.synthesisUnavailable, workflowId]);

  function trackInteraction(action: string, extra: Record<string, unknown> = {}) {
    emitAnalytics("assistant.widget_interaction", {
      widget_kind: "meeting_prep",
      action,
      meeting_id: spec.meetingId,
      ...extra,
      ...(workflowId ? { workflow_id: workflowId } : {}),
    });
  }

  function clickSourceRef(ref: MeetingPrepWidgetSourceRef) {
    emitAnalytics("assistant.meeting_prep_source_clicked", {
      meeting_id: spec.meetingId,
      ref_type: ref.type,
      ref_id: ref.id,
      ...(workflowId ? { workflow_id: workflowId } : {}),
    });
    trackInteraction("source_clicked", { ref_type: ref.type });
  }

  async function clickRegenerate() {
    if (!spec.viewerCanRegenerate || regenStatus === "loading") return;
    setRegenStatus("loading");
    trackInteraction("regenerate_clicked");
    try {
      const res = await fetchWithRefresh(
        `/api/insights/meeting-prep?event_id=${encodeURIComponent(spec.meetingId)}&force=1`,
        { method: "GET" },
      );
      if (!res || !res.ok) {
        setRegenStatus("error");
        return;
      }
      /* The route returns the new prep; rather than mutate state in
       * place (the widget is read-only by design), prompt the user to
       * re-ask. Keeps the widget framework's "one render per spec"
       * invariant intact. */
      setRegenStatus("idle");
      if (typeof window !== "undefined") {
        window.location.reload();
      }
    } catch {
      setRegenStatus("error");
    }
  }

  const cachePillText =
    spec.cacheStatus === "hit"
      ? "Shared with team"
      : spec.cacheStatus === "regenerated"
        ? "Regenerated"
        : "Fresh";
  const cachePillBg =
    spec.cacheStatus === "hit"
      ? "var(--wp-info, #3b82f6)"
      : "var(--wp-gold, #eab308)";

  return (
    <div
      data-testid="meeting-prep-widget"
      className="mt-2 rounded-md p-3"
      style={{
        background: "var(--wp-dark-surface2, #1a1a1a)",
        border: "1px solid var(--wp-dark-border, #333)",
      }}
    >
      <div className="flex items-start justify-between gap-3 mb-2">
        <div>
          <div className="text-sm font-semibold" style={{ color: "var(--wp-text, #eee)" }}>
            {spec.subject}
          </div>
          <div className="text-xs" style={{ color: "var(--wp-text-muted, #6b7280)" }}>
            {formatStart(spec.start)}
          </div>
        </div>
        <div className="flex flex-col items-end gap-1">
          <span
            data-testid="meeting-prep-cache-pill"
            className="text-xs px-2 py-0.5 rounded"
            style={{
              background: cachePillBg,
              color: "#000",
              fontWeight: 600,
            }}
          >
            {cachePillText}
          </span>
          {spec.viewerCanRegenerate && (
            <button
              type="button"
              data-testid="meeting-prep-regenerate"
              onClick={clickRegenerate}
              disabled={regenStatus === "loading"}
              className="text-xs"
              style={{
                color: "var(--wp-gold, #eab308)",
                cursor: regenStatus === "loading" ? "wait" : "pointer",
                background: "transparent",
                border: "none",
                padding: 0,
              }}
            >
              {regenStatus === "loading" ? "Regenerating…" : "Regenerate"}
            </button>
          )}
          {regenStatus === "error" && (
            <span className="text-xs" style={{ color: "var(--wp-danger, #ef4444)" }}>
              Regen failed
            </span>
          )}
        </div>
      </div>

      {spec.synthesisUnavailable ? (
        <div
          data-testid="meeting-prep-unavailable"
          className="text-xs py-3"
          style={{ color: "var(--wp-text-muted, #6b7280)" }}
        >
          Synthesis unavailable. The source data is still queryable but the
          summary could not be generated. Try regenerating in a moment.
        </div>
      ) : (
        <div className="space-y-3">
          {spec.summary && (
            <Section title="Summary">
              <p className="text-xs" style={{ color: "var(--wp-text, #eee)" }}>
                {spec.summary}
              </p>
            </Section>
          )}

          {spec.goal && (
            <Section title="Goal">
              <p className="text-xs" style={{ color: "var(--wp-text, #eee)" }}>
                {spec.goal}
              </p>
            </Section>
          )}

          {spec.talking_points.length > 0 && (
            <Section title="Talking points">
              <ul className="space-y-1" data-testid="meeting-prep-talking-points">
                {spec.talking_points.map((tp, idx) => (
                  <li
                    key={idx}
                    data-testid={`meeting-prep-talking-point-${idx}`}
                    className="text-xs"
                    style={{ color: "var(--wp-text, #eee)" }}
                  >
                    <button
                      type="button"
                      onClick={() =>
                        trackInteraction("talking_point_expanded", {
                          item_index: idx,
                        })
                      }
                      style={{
                        background: "transparent",
                        border: "none",
                        padding: 0,
                        color: "inherit",
                        textAlign: "left",
                        cursor: "pointer",
                      }}
                    >
                      {tp.point}
                    </button>
                    {tp.source_refs.length > 0 && (
                      <div className="mt-0.5 flex flex-wrap gap-2">
                        {tp.source_refs.map((ref) => (
                          <SourceChip
                            key={`${ref.type}:${ref.id}`}
                            ref={ref}
                            onClick={() => clickSourceRef(ref)}
                          />
                        ))}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {spec.risk_flags.length > 0 && (
            <Section title="Risks">
              <ul className="space-y-1" data-testid="meeting-prep-risks">
                {spec.risk_flags.map((rf, idx) => (
                  <li
                    key={idx}
                    data-testid={`meeting-prep-risk-${idx}`}
                    className="text-xs flex items-start gap-2"
                  >
                    <span
                      data-testid={`meeting-prep-risk-severity-${idx}`}
                      className="inline-block px-1.5 py-0.5 rounded uppercase"
                      style={{
                        background: severityColor(rf.severity),
                        color: "#000",
                        fontSize: 10,
                        fontWeight: 700,
                      }}
                    >
                      {rf.severity}
                    </span>
                    <span style={{ color: "var(--wp-text, #eee)" }}>
                      {rf.flag}
                    </span>
                    {rf.source_refs.length > 0 && (
                      <div className="flex flex-wrap gap-2">
                        {rf.source_refs.map((ref) => (
                          <SourceChip
                            key={`${ref.type}:${ref.id}`}
                            ref={ref}
                            onClick={() => clickSourceRef(ref)}
                          />
                        ))}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {spec.attendee_briefs.length > 0 && (
            <Section title="Attendees">
              <ul className="space-y-2" data-testid="meeting-prep-attendees">
                {spec.attendee_briefs.map((ab, idx) => (
                  <li
                    key={ab.email}
                    data-testid={`meeting-prep-attendee-${idx}`}
                    className="text-xs rounded px-2 py-1.5"
                    style={{
                      background: "var(--wp-dark, #111)",
                      border: "1px solid var(--wp-dark-border, #333)",
                    }}
                  >
                    <div className="font-medium" style={{ color: "var(--wp-text, #eee)" }}>
                      {ab.name || ab.email}
                    </div>
                    {ab.one_liner && (
                      <div style={{ color: "var(--wp-text-muted, #9ca3af)" }}>
                        {ab.one_liner}
                      </div>
                    )}
                    {ab.key_facts.length > 0 && (
                      <ul
                        className="mt-1 list-disc list-inside"
                        style={{ color: "var(--wp-text, #eee)" }}
                      >
                        {ab.key_facts.map((f, i) => (
                          <li key={i}>{f}</li>
                        ))}
                      </ul>
                    )}
                    {ab.links.length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-2">
                        {ab.links.map((ref) => (
                          <SourceChip
                            key={`${ref.type}:${ref.id}`}
                            ref={ref}
                            onClick={() => clickSourceRef(ref)}
                          />
                        ))}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {spec.open_questions.length > 0 && (
            <Section title="Open questions">
              <ul
                className="space-y-1 list-disc list-inside"
                data-testid="meeting-prep-open-questions"
                style={{ color: "var(--wp-text, #eee)" }}
              >
                {spec.open_questions.map((q, idx) => (
                  <li key={idx} className="text-xs">
                    {q}
                  </li>
                ))}
              </ul>
            </Section>
          )}
        </div>
      )}
    </div>
  );
}

interface SectionProps {
  title: string;
  children: React.ReactNode;
}

function Section({ title, children }: SectionProps) {
  return (
    <div>
      <div
        className="text-xs uppercase tracking-wide mb-1"
        style={{ color: "var(--wp-text-muted, #9ca3af)", fontWeight: 600 }}
      >
        {title}
      </div>
      {children}
    </div>
  );
}

interface SourceChipProps {
  ref: MeetingPrepWidgetSourceRef;
  onClick: () => void;
}

function SourceChip({ ref, onClick }: SourceChipProps) {
  /* Source refs are always EXTERNAL deep-links (Outlook web link, Salesforce
   * record URL, brain doc UI). For internal nav we'd use next/link; the
   * data shape here is opaque on type so we render a plain anchor when a
   * URL is provided and a button when it isn't. */
  const common = {
    onClick,
    "data-testid": `meeting-prep-source-${ref.type}-${ref.id}`,
    "data-ref-type": ref.type,
    className: "text-xs px-1.5 py-0.5 rounded",
    style: {
      background: "var(--wp-dark-surface3, #222)",
      border: "1px solid var(--wp-dark-border, #333)",
      color: "var(--wp-gold, #eab308)",
      cursor: "pointer",
    },
  } as const;
  if (ref.url) {
    return (
      <a
        {...common}
        href={ref.url}
        target="_blank"
        rel="noreferrer noopener"
      >
        {ref.label || `${ref.type}:${ref.id}`}
      </a>
    );
  }
  return (
    <button type="button" {...common}>
      {ref.label || `${ref.type}:${ref.id}`}
    </button>
  );
}
