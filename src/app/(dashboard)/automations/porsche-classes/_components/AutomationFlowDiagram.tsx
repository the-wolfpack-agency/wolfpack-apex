"use client";

/**
 * AutomationFlowDiagram — visual representation of the
 * porsche-classes automation pipeline. Renders the steps a user
 * would otherwise execute manually so non-technical stakeholders
 * understand exactly what the system is doing on their behalf.
 *
 * 7 nodes, left-to-right on wide viewports, top-to-bottom on
 * narrow. Color-coded by role: blue = input, gold = processing,
 * green = human review, purple = system of record. Pure CSS/SVG;
 * no new deps.
 *
 * Collapsible — defaults to OPEN on first visit so the user sees
 * the diagram without clicking, but can be hidden once they're
 * familiar. Persisted to localStorage.
 */

import { useEffect, useState } from "react";

type Tone = "input" | "process" | "human" | "store";

interface Node {
  id: string;
  label: string;
  detail: string;
  tone: Tone;
  /** Optional emoji glyph rendered to the left of the label. */
  glyph: string;
}

const NODES: Node[] = [
  {
    id: "feeds",
    glyph: "📥",
    label: "Email feeds",
    detail: "Coordinator notes, instructor notes, roster, survey CSV — ingested as they arrive.",
    tone: "input",
  },
  {
    id: "parsers",
    glyph: "⚙️",
    label: "Parsers",
    detail: "One parser per format. Free-form email → structured fields.",
    tone: "process",
  },
  {
    id: "snapshots",
    glyph: "🗂️",
    label: "Snapshots",
    detail: "Each parsed document stored in Postgres, tagged with class_key.",
    tone: "store",
  },
  {
    id: "assembler",
    glyph: "🧩",
    label: "Assembler",
    detail: "All snapshots for one class fused into a single AssembledSummary.",
    tone: "process",
  },
  {
    id: "exceptions",
    glyph: "🚨",
    label: "Exception detector",
    detail: "Flags missing roster, mismatched dates, low survey response — surfaced inline.",
    tone: "process",
  },
  {
    id: "review",
    glyph: "👀",
    label: "You review",
    detail: "Open the summary, scan exceptions, choose how to ship.",
    tone: "human",
  },
  {
    id: "sharepoint",
    glyph: "📤",
    label: "SharePoint",
    detail: "One click renders Word + uploads to the configured folder. Audit row written.",
    tone: "store",
  },
];

const TONE_STYLES: Record<Tone, { border: string; bg: string; accent: string }> = {
  input: {
    border: "var(--wp-info, #38bdf8)",
    bg: "rgba(56, 189, 248, 0.08)",
    accent: "var(--wp-info, #38bdf8)",
  },
  process: {
    border: "var(--wp-gold, #eab308)",
    bg: "rgba(234, 179, 8, 0.08)",
    accent: "var(--wp-gold, #eab308)",
  },
  human: {
    border: "var(--wp-success, #22c55e)",
    bg: "rgba(34, 197, 94, 0.10)",
    accent: "var(--wp-success, #22c55e)",
  },
  store: {
    border: "#a78bfa",
    bg: "rgba(167, 139, 250, 0.08)",
    accent: "#a78bfa",
  },
};

const STORAGE_KEY = "instinct.automation_flow.collapsed";

export default function AutomationFlowDiagram() {
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(STORAGE_KEY, collapsed ? "1" : "0");
  }, [collapsed]);

  return (
    <section
      data-testid="automation-flow-diagram"
      style={{
        marginTop: "1.5rem",
        marginBottom: "1.5rem",
        border: "1px solid var(--wp-dark-border)",
        borderRadius: 8,
        background: "var(--wp-dark-surface)",
        overflow: "hidden",
      }}
    >
      <button
        type="button"
        data-testid="automation-flow-toggle"
        onClick={() => setCollapsed((v) => !v)}
        aria-expanded={!collapsed}
        style={{
          display: "flex",
          width: "100%",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0.7rem 1rem",
          border: "none",
          background: "var(--wp-dark-surface2)",
          color: "var(--wp-text)",
          cursor: "pointer",
          textAlign: "left",
        }}
      >
        <span style={{ fontWeight: 600 }}>How this automation works</span>
        <span
          aria-hidden="true"
          style={{ color: "var(--wp-text-dim)", fontSize: "0.85rem" }}
        >
          {collapsed ? "▸ Show flow" : "▾ Hide flow"}
        </span>
      </button>

      {!collapsed ? (
        <div
          data-testid="automation-flow-body"
          style={{ padding: "1rem" }}
        >
          <p
            style={{
              color: "var(--wp-text-dim)",
              fontSize: "0.85rem",
              margin: "0 0 1rem",
              maxWidth: "70ch",
              lineHeight: 1.5,
            }}
          >
            Each box was a manual step the program team used to do by hand.
            Arrows show where the data flows. Only the green box still
            requires you — everything else runs continuously in the
            background.
          </p>

          <ol
            data-testid="automation-flow-steps"
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: "0.6rem",
              listStyle: "none",
              padding: 0,
              margin: 0,
              alignItems: "stretch",
            }}
          >
            {NODES.map((node, i) => (
              <li
                key={node.id}
                data-testid={`automation-flow-node-${node.id}`}
                data-tone={node.tone}
                style={{
                  flex: "1 1 200px",
                  minWidth: 180,
                  maxWidth: 260,
                  display: "flex",
                  flexDirection: "column",
                  position: "relative",
                  padding: "0.7rem 0.85rem",
                  border: `1px solid ${TONE_STYLES[node.tone].border}`,
                  borderLeft: `4px solid ${TONE_STYLES[node.tone].accent}`,
                  borderRadius: 6,
                  background: TONE_STYLES[node.tone].bg,
                  color: "var(--wp-text)",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    marginBottom: 4,
                  }}
                >
                  <span
                    aria-hidden="true"
                    style={{ fontSize: "1.1rem", lineHeight: 1 }}
                  >
                    {node.glyph}
                  </span>
                  <span
                    style={{
                      fontWeight: 600,
                      fontSize: "0.85rem",
                      color: TONE_STYLES[node.tone].accent,
                    }}
                  >
                    {i + 1}. {node.label}
                  </span>
                </div>
                <span
                  style={{
                    fontSize: "0.78rem",
                    color: "var(--wp-text-dim)",
                    lineHeight: 1.45,
                  }}
                >
                  {node.detail}
                </span>
                {/* Arrow to next node — hidden on the last one and on
                    narrow viewports where boxes stack vertically. */}
                {i < NODES.length - 1 ? (
                  <span
                    aria-hidden="true"
                    data-testid={`automation-flow-arrow-${node.id}`}
                    style={{
                      position: "absolute",
                      right: -14,
                      top: "50%",
                      transform: "translateY(-50%)",
                      color: "var(--wp-text-dim)",
                      fontSize: "1rem",
                      pointerEvents: "none",
                    }}
                  >
                    →
                  </span>
                ) : null}
              </li>
            ))}
          </ol>

          <div
            style={{
              display: "flex",
              gap: "0.85rem",
              marginTop: "0.9rem",
              flexWrap: "wrap",
              fontSize: "0.72rem",
              color: "var(--wp-text-dim)",
            }}
          >
            <LegendDot color={TONE_STYLES.input.accent} label="Input — data comes in" />
            <LegendDot color={TONE_STYLES.process.accent} label="System processing" />
            <LegendDot color={TONE_STYLES.human.accent} label="You review" />
            <LegendDot color={TONE_STYLES.store.accent} label="System of record" />
          </div>

          <p
            style={{
              fontSize: "0.72rem",
              color: "var(--wp-text-muted)",
              marginTop: "0.9rem",
              marginBottom: 0,
            }}
          >
            Full write-up + troubleshooting:{" "}
            <code>docs/features/porsche-classes-flow.md</code>
          </p>
        </div>
      ) : null}
    </section>
  );
}

function LegendDot(props: { color: string; label: string }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 10,
          height: 10,
          borderRadius: 999,
          background: props.color,
          display: "inline-block",
        }}
      />
      {props.label}
    </span>
  );
}
