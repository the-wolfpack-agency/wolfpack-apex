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
  /** Tools / steps the user previously did by hand. */
  before: string;
  /** What now happens automatically (or in one click). */
  after: string;
}

const NODES: Node[] = [
  {
    id: "feeds",
    glyph: "📥",
    label: "Emails arrive",
    detail: "Coordinator notes, instructor notes, the roster, and the survey come in by email and are picked up automatically.",
    tone: "input",
    before: "Outlook inbox. You watched for and forwarded each email manually.",
    after: "Instinct watches Outlook. New messages appear here as they arrive.",
  },
  {
    id: "parsers",
    glyph: "⚙️",
    label: "Read each email",
    detail: "Each kind of email gets read and turned into clean, organized information.",
    tone: "process",
    before: "You opened each Word doc, Excel file, and Cognito form and copied the relevant fields manually.",
    after: "Instinct reads each one and extracts the names, dates, scores, and notes.",
  },
  {
    id: "snapshots",
    glyph: "🗂️",
    label: "Save the pieces",
    detail: "Every email is saved and tagged with the class it belongs to so nothing gets lost.",
    tone: "store",
    before: "OneDrive folders, Outlook flags, and a personal spreadsheet to track what had arrived.",
    after: "Each item is stored and tagged with the class it belongs to.",
  },
  {
    id: "assembler",
    glyph: "🧩",
    label: "Build the summary",
    detail: "All the pieces for one class are combined into a single class summary.",
    tone: "process",
    before: "Word. You opened the template and re-typed each field from your notes.",
    after: "Instinct fills the template. Coordinator notes, instructor notes, attendees, and survey questions are placed in the matching sections.",
  },
  {
    id: "exceptions",
    glyph: "🚨",
    label: "Check for gaps",
    detail: "Flags anything missing or unusual (no roster, dates that do not match, surveys with few responses).",
    tone: "process",
    before: "You scanned the email thread for missing pieces or incorrect dates.",
    after: "Instinct flags issues (missing roster, mismatched dates, low survey turnout) on the summary page.",
  },
  {
    id: "review",
    glyph: "👀",
    label: "You review",
    detail: "Open the summary, look over any flags, and choose how to share it.",
    tone: "human",
    before: "You read the document end to end and edited it before sending.",
    after: "You open the finished summary, review any flags, and decide how to share it.",
  },
  {
    id: "sharepoint",
    glyph: "📤",
    label: "Send to SharePoint",
    detail: "One click creates the Word file and saves it to the right SharePoint folder. The action is logged so you can undo it.",
    tone: "store",
    before: "Save as Word, open SharePoint in the browser, drag the file into the correct folder, share the link.",
    after: "One click sends the Word file to the configured SharePoint folder. The action is logged and can be undone.",
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
            Every box used to be a step you did by hand. Arrows show
            how the work moves from one step to the next. Only the
            green box still needs you. Everything else happens
            automatically in the background.
          </p>

          <div
            data-testid="automation-flow-tools-replaced"
            style={{
              marginBottom: "1rem",
              padding: "0.75rem 0.9rem",
              border: "1px solid var(--wp-dark-border)",
              borderLeft: "3px solid var(--wp-gold, #eab308)",
              borderRadius: 6,
              background: "var(--wp-dark-surface2)",
              fontSize: "0.78rem",
              lineHeight: 1.5,
              color: "var(--wp-text)",
            }}
          >
            <div
              style={{
                fontWeight: 600,
                color: "var(--wp-gold, #eab308)",
                marginBottom: 6,
              }}
            >
              Previous tools used for this process
            </div>
            <div style={{ color: "var(--wp-text-dim)" }}>
              Outlook (forwarding emails), Excel (the roster), Cognito
              Forms (the survey), Word (the template), OneDrive (saving
              drafts), and SharePoint (filing the final document).
            </div>
            <div
              style={{
                marginTop: 8,
                fontWeight: 600,
                color: "var(--wp-success, #22c55e)",
              }}
            >
              New automated process
            </div>
            <div style={{ color: "var(--wp-text-dim)" }}>
              One page in Instinct. Emails are collected and read for
              you, the Word document is built, and it is filed to
              SharePoint when you click Send. You review the finished
              summary.
            </div>
          </div>

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
                <div
                  data-testid={`automation-flow-compare-${node.id}`}
                  style={{
                    marginTop: "0.55rem",
                    paddingTop: "0.5rem",
                    borderTop: "1px dashed var(--wp-dark-border)",
                    display: "flex",
                    flexDirection: "column",
                    gap: 4,
                    fontSize: "0.72rem",
                    lineHeight: 1.4,
                  }}
                >
                  <span style={{ color: "var(--wp-text-muted)" }}>
                    <strong style={{ color: "var(--wp-text-dim)" }}>Before:</strong>{" "}
                    {node.before}
                  </span>
                  <span style={{ color: "var(--wp-text-muted)" }}>
                    <strong
                      style={{ color: TONE_STYLES[node.tone].accent }}
                    >
                      Now:
                    </strong>{" "}
                    {node.after}
                  </span>
                </div>
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
            <LegendDot color={TONE_STYLES.input.accent} label="Information coming in" />
            <LegendDot color={TONE_STYLES.process.accent} label="The system does the work" />
            <LegendDot color={TONE_STYLES.human.accent} label="You take a look" />
            <LegendDot color={TONE_STYLES.store.accent} label="Saved for the record" />
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
