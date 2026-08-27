/**
 * PilotStatusWidget: how the engagement is going, from three systems at once.
 *
 * THE ONE RULE THIS COMPONENT EXISTS TO ENFORCE: a source that could not be
 * read must never look like a source that returned nothing. They are opposite
 * answers and an empty column renders them identically. So a dark source shows
 * a dash and the word "not read", never a zero, and it keeps its row rather
 * than being filtered out of the list. Hiding it would leave a confident
 * headline over a picture that is quietly missing a third of its evidence.
 */

"use client";

import { useEffect } from "react";
import { fetchWithRefresh } from "@/lib/client-auth";
import type { PilotStatusWidgetSpec } from "@/lib/assistant/widgets/types";
import { StaggeredItem, useStaggeredReveal } from "./StaggeredItem";

function toneColor(tone: string): string {
  switch (tone) {
    case "blocker":
      return "var(--wp-error, #dc2626)";
    case "watch":
      return "var(--wp-warning, #eab308)";
    case "good":
      return "var(--wp-success, #16a34a)";
    default:
      /* dark: the source was not read. Deliberately not a severity colour. */
      return "var(--wp-text-muted, #6b7280)";
  }
}

function readinessColor(r: string): string {
  switch (r) {
    case "blocked":
      return "var(--wp-error, #dc2626)";
    case "at_risk":
      return "var(--wp-warning, #eab308)";
    case "on_track":
      return "var(--wp-success, #16a34a)";
    default:
      return "var(--wp-text-muted, #6b7280)";
  }
}

const SOURCE_LABEL: Record<string, string> = {
  calendar: "Calendar",
  documents: "Brain",
  tasks: "Tasks",
};

export interface PilotStatusWidgetProps {
  spec: PilotStatusWidgetSpec;
  workflowId?: string;
}

export function PilotStatusWidget({ spec, workflowId }: PilotStatusWidgetProps) {
  const darkCount = spec.sources.filter((s) => s.state !== "ok").length;

  useEffect(() => {
    fetchWithRefresh("/api/analytics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "assistant.widget_rendered",
        metadata: {
          widget_kind: "pilot_status",
          readiness: spec.readiness,
          signal_count: spec.signals.length,
          dark_source_count: darkCount,
          ...(workflowId ? { workflow_id: workflowId } : {}),
        },
      }),
    }).catch(() => undefined);
  }, [spec.readiness, spec.signals.length, darkCount, workflowId]);

  useStaggeredReveal({
    widgetKind: "pilot_status",
    itemCount: spec.signals.length,
    workflowId,
  });

  return (
    <div
      data-testid="pilot-status-widget"
      data-readiness={spec.readiness}
      className="mt-2 rounded-md p-3 min-w-0 max-w-full overflow-hidden"
      style={{
        background: "var(--wp-dark-surface2, #1a1a1a)",
        border: "1px solid var(--wp-dark-border, #333)",
      }}
    >
      <div className="mb-2">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <span
              className="inline-block w-2 h-2 rounded-full shrink-0"
              style={{ background: readinessColor(spec.readiness) }}
              aria-label={`readiness ${spec.readiness}`}
            />
            <span
              data-testid="pilot-status-headline"
              className="text-sm font-semibold truncate"
              style={{ color: "var(--wp-gold, #eab308)" }}
            >
              {spec.title}
            </span>
          </div>
          <span
            className="text-[10px] uppercase tracking-wider whitespace-nowrap"
            style={{ color: "var(--wp-text-muted, #6b7280)" }}
          >
            {spec.sources.length - darkCount}/3 systems
          </span>
        </div>
        {spec.subtitle && (
          <div
            data-testid="pilot-status-subtitle"
            className="text-xs mt-0.5"
            style={{ color: "var(--wp-text-dim, #aaa)" }}
          >
            {spec.subtitle}
          </div>
        )}
      </div>

      {/* THE THREE SYSTEMS. Always all three, dark ones included. */}
      <div className="grid grid-cols-3 gap-1.5 mb-2">
        {spec.sources.map((s) => (
          <div
            key={s.source}
            data-testid={`pilot-status-source-${s.source}`}
            data-state={s.state}
            title={s.detail}
            className="rounded p-2 min-w-0"
            style={{
              background: "var(--wp-dark, #111)",
              border: "1px solid var(--wp-dark-border, #333)",
              opacity: s.state === "ok" ? 1 : 0.7,
            }}
          >
            <div
              className="text-[9px] uppercase tracking-wider"
              style={{ color: "var(--wp-text-muted, #6b7280)" }}
            >
              {SOURCE_LABEL[s.source] ?? s.source}
            </div>
            {/* A DASH, NEVER A ZERO, when the source was not read. */}
            <div
              data-testid={`pilot-status-count-${s.source}`}
              className={s.count === null ? "text-xs font-semibold italic" : "text-base font-semibold"}
              style={{
                color: s.state === "ok" ? "var(--wp-text, #eee)" : "var(--wp-text-muted, #6b7280)",
              }}
            >
              {/* THE WORD, not a dash and never a 0. A punctuation mark in a
                  number slot gets read as "none"; the word cannot be. */}
              {s.count === null ? "unknown" : s.count}
            </div>
            <div
              data-testid={`pilot-status-state-${s.source}`}
              className="text-[10px] leading-tight"
              style={{ color: "var(--wp-text-dim, #aaa)" }}
            >
              {s.state === "ok"
                ? s.detail
                : s.state === "not_connected"
                  ? "not connected"
                  : "not read"}
            </div>
          </div>
        ))}
      </div>

      {spec.nextCheckpoint && (
        <div
          data-testid="pilot-status-next-checkpoint"
          className="text-xs mb-2 rounded p-2"
          style={{
            background: "var(--wp-dark, #111)",
            border: "1px solid var(--wp-dark-border, #333)",
            color: "var(--wp-text-dim, #aaa)",
          }}
        >
          <span style={{ color: "var(--wp-text-muted, #6b7280)" }}>Next checkpoint: </span>
          <span style={{ color: "var(--wp-text, #eee)" }}>{spec.nextCheckpoint.subject}</span>
          <span> · {spec.nextCheckpoint.when}</span>
        </div>
      )}

      {spec.signals.length === 0 ? (
        <div
          data-testid="pilot-status-no-signals"
          className="text-xs py-3 text-center"
          style={{ color: "var(--wp-text-muted, #6b7280)" }}
        >
          Nothing to flag from the systems that answered.
        </div>
      ) : (
        <ul className="space-y-1.5">
          {spec.signals.map((item, i) => (
            <StaggeredItem
              key={item.id}
              index={i}
              data-testid={`pilot-status-signal-${item.id}`}
              data-tone={item.tone}
              className="text-xs rounded p-2"
              style={{
                background: "var(--wp-dark, #111)",
                border: "1px solid var(--wp-dark-border, #333)",
              }}
            >
              <div className="flex items-baseline justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span
                    className="inline-block w-2 h-2 rounded-full shrink-0"
                    style={{ background: toneColor(item.tone) }}
                    aria-label={`signal ${item.tone}`}
                  />
                  <span
                    className="font-semibold truncate"
                    style={{ color: "var(--wp-text, #eee)" }}
                  >
                    {item.title}
                  </span>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  {/* Two badges means the row is a fact no single tool holds. */}
                  {item.sources.map((s) => (
                    <span
                      key={s}
                      className="text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded"
                      style={{
                        background: "var(--wp-dark-surface2, #1a1a1a)",
                        color: "var(--wp-text-muted, #6b7280)",
                        border: "1px solid var(--wp-dark-border, #333)",
                      }}
                    >
                      {SOURCE_LABEL[s] ?? s}
                    </span>
                  ))}
                </div>
              </div>
              <div className="text-[11px] mt-1" style={{ color: "var(--wp-text-dim, #aaa)" }}>
                {item.detail}
              </div>
            </StaggeredItem>
          ))}
        </ul>
      )}
    </div>
  );
}
