"use client";

/**
 * /emails — left nav rail (Gmail-style).
 *
 * Holds the "+ Compose" CTA and folder navigation (Inbox, Drafts,
 * Sent, Archived) plus a Templates accordion. Collapsible: 240px
 * expanded, 56px collapsed. On mobile, the parent treats this as a
 * full-screen drawer; on desktop, the user toggles between collapsed
 * and expanded.
 *
 * v1 only fully wires "Inbox" and "Templates" — the Drafts/Sent/
 * Archived rows are visual placeholders (data-testid present so we
 * can wire them up in a follow-up without re-rendering the chrome).
 *
 * Templates: when the user clicks a template name, we forward to
 * onApplyTemplate — same wire that the previous Templates rail used,
 * preserved for backwards compat with the existing page tests.
 */

import type React from "react";
import { useState } from "react";

export interface EmailTemplate {
  id: string;
  name: string;
  description: string;
  requiredVariables: string[];
  optionalVariables: string[];
}

export type EmailFolder = "inbox" | "drafts" | "sent" | "archived";

interface EmailNavRailProps {
  expanded: boolean;
  onToggle: () => void;
  onCompose: () => void;
  activeFolder: EmailFolder;
  onSelectFolder: (folder: EmailFolder) => void;
  templates: EmailTemplate[];
  templatesLoading: boolean;
  onApplyTemplate: (t: EmailTemplate) => void;
}

const FOLDERS: { id: EmailFolder; label: string; icon: string }[] = [
  { id: "inbox", label: "Inbox", icon: "✉" },
  { id: "drafts", label: "Drafts", icon: "✎" },
  { id: "sent", label: "Sent", icon: "→" },
  { id: "archived", label: "Archived", icon: "▦" },
];

export default function EmailNavRail({
  expanded,
  onToggle,
  onCompose,
  activeFolder,
  onSelectFolder,
  templates,
  templatesLoading,
  onApplyTemplate,
}: EmailNavRailProps) {
  const [templatesOpen, setTemplatesOpen] = useState(true);

  return (
    <nav
      aria-label="Email navigation"
      data-testid="email-nav-rail"
      data-expanded={expanded}
      style={{
        ...wrap,
        width: expanded ? 240 : 56,
      }}
    >
      <div style={topRow}>
        <button
          type="button"
          onClick={onToggle}
          aria-label={expanded ? "Collapse navigation" : "Expand navigation"}
          aria-expanded={expanded}
          data-testid="nav-rail-toggle"
          style={iconBtn}
        >
          {expanded ? "‹" : "›"}
        </button>
      </div>

      <button
        type="button"
        onClick={onCompose}
        data-testid="nav-rail-compose"
        aria-label="Compose new email"
        style={{
          ...composeBtn,
          padding: expanded ? "0.55rem 0.9rem" : "0.55rem 0",
          justifyContent: expanded ? "flex-start" : "center",
        }}
      >
        <span style={{ fontWeight: 700, fontSize: "1rem", lineHeight: 1 }}>+</span>
        {expanded ? <span style={{ marginLeft: 8 }}>Compose</span> : null}
      </button>

      <ul style={folderList}>
        {FOLDERS.map((f) => {
          const active = f.id === activeFolder;
          return (
            <li key={f.id}>
              <button
                type="button"
                onClick={() => onSelectFolder(f.id)}
                data-testid={`nav-folder-${f.id}`}
                aria-current={active ? "page" : undefined}
                title={!expanded ? f.label : undefined}
                style={{
                  ...folderBtn,
                  ...(active ? folderBtnActive : {}),
                  justifyContent: expanded ? "flex-start" : "center",
                  padding: expanded ? "0.45rem 0.8rem" : "0.45rem 0",
                }}
              >
                <span style={folderIcon} aria-hidden="true">
                  {f.icon}
                </span>
                {expanded ? (
                  <span style={folderLabel}>{f.label}</span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>

      {expanded ? (
        <div style={templatesSection}>
          <button
            type="button"
            onClick={() => setTemplatesOpen((v) => !v)}
            data-testid="nav-rail-templates-toggle"
            aria-expanded={templatesOpen}
            style={templatesHeader}
          >
            <span style={{ fontSize: "0.7rem", letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--wp-text-dim)" }}>
              Templates
            </span>
            <span style={{ color: "var(--wp-text-dim)" }}>
              {templatesOpen ? "▾" : "▸"}
            </span>
          </button>
          {templatesOpen ? (
            <div style={templatesBody}>
              {templatesLoading ? (
                <p style={dimText}>Loading…</p>
              ) : templates.length === 0 ? (
                <p style={dimText}>No templates available</p>
              ) : (
                templates.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    data-testid={`template-${t.id}`}
                    onClick={() => onApplyTemplate(t)}
                    style={templateBtn}
                    title={t.description}
                  >
                    <span style={{ fontWeight: 600, fontSize: "0.78rem", color: "var(--wp-text)" }}>
                      {t.name}
                    </span>
                    <span style={{ fontSize: "0.7rem", color: "var(--wp-text-dim)", marginTop: 2 }}>
                      {t.description}
                    </span>
                  </button>
                ))
              )}
            </div>
          ) : null}
        </div>
      ) : null}
    </nav>
  );
}

const wrap: React.CSSProperties = {
  background: "var(--wp-dark-surface)",
  border: "1px solid var(--wp-dark-border)",
  borderRadius: 8,
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
  flexShrink: 0,
  transition: "width 140ms ease",
  minHeight: 0,
};

const topRow: React.CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  padding: "0.4rem 0.5rem",
  borderBottom: "1px solid var(--wp-dark-border)",
  background: "var(--wp-dark-surface2)",
};

const iconBtn: React.CSSProperties = {
  background: "transparent",
  border: "none",
  color: "var(--wp-text-dim)",
  cursor: "pointer",
  fontSize: "1rem",
  padding: "0.15rem 0.45rem",
  lineHeight: 1,
};

const composeBtn: React.CSSProperties = {
  margin: "0.6rem",
  background: "var(--wp-gold)",
  color: "var(--wp-dark)",
  border: "none",
  borderRadius: 6,
  fontSize: "0.82rem",
  fontWeight: 700,
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  whiteSpace: "nowrap",
};

const folderList: React.CSSProperties = {
  listStyle: "none",
  padding: 0,
  margin: "0.2rem 0.4rem",
  display: "flex",
  flexDirection: "column",
  gap: 2,
};

const folderBtn: React.CSSProperties = {
  width: "100%",
  background: "transparent",
  border: "none",
  borderRadius: 6,
  color: "var(--wp-text)",
  cursor: "pointer",
  fontSize: "0.82rem",
  display: "flex",
  alignItems: "center",
  textAlign: "left",
};

const folderBtnActive: React.CSSProperties = {
  background: "var(--wp-dark-surface2)",
  color: "var(--wp-gold)",
  fontWeight: 600,
};

const folderIcon: React.CSSProperties = {
  fontSize: "0.95rem",
  width: 20,
  textAlign: "center",
  color: "var(--wp-text-dim)",
};

const folderLabel: React.CSSProperties = {
  marginLeft: 10,
};

const templatesSection: React.CSSProperties = {
  marginTop: "0.4rem",
  borderTop: "1px solid var(--wp-dark-border)",
  display: "flex",
  flexDirection: "column",
  flex: 1,
  minHeight: 0,
  overflow: "hidden",
};

const templatesHeader: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  background: "transparent",
  border: "none",
  padding: "0.55rem 0.8rem",
  cursor: "pointer",
  width: "100%",
};

const templatesBody: React.CSSProperties = {
  padding: "0.2rem 0.5rem 0.5rem",
  display: "flex",
  flexDirection: "column",
  gap: "0.35rem",
  overflowY: "auto",
  flex: 1,
  minHeight: 0,
};

const templateBtn: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  textAlign: "left",
  padding: "0.45rem 0.55rem",
  background: "var(--wp-dark-surface2)",
  border: "1px solid var(--wp-dark-border)",
  borderRadius: 6,
  color: "var(--wp-text)",
  cursor: "pointer",
  fontSize: "0.78rem",
};

const dimText: React.CSSProperties = {
  fontSize: "0.78rem",
  color: "var(--wp-text-dim)",
  margin: "0.4rem 0.4rem",
};
