"use client";

/**
 * /emails — empty state for the right (reader/composer) pane.
 *
 * Shown when no thread is selected AND the user has not clicked
 * "New email" yet. Mirrors Gmail's middle-pane affordance: a soft
 * illustration + a one-line prompt nudging the user toward either
 * reading a thread or starting a new draft.
 */

import type React from "react";

interface EmptyStateProps {
  onCompose: () => void;
}

export default function EmptyState({ onCompose }: EmptyStateProps) {
  return (
    <div style={wrap} data-testid="emails-empty-state">
      <div style={iconWrap} aria-hidden="true">
        <svg width="56" height="56" viewBox="0 0 24 24" fill="none" role="img">
          <rect
            x="2.5"
            y="5"
            width="19"
            height="14"
            rx="2"
            stroke="var(--wp-gold)"
            strokeWidth="1.5"
          />
          <path
            d="M3 6.5l9 6.5 9-6.5"
            stroke="var(--wp-gold)"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
      <h2 style={heading}>Nothing selected</h2>
      <p style={body}>
        Select a message on the left to read it, or start a fresh draft.
      </p>
      <button
        type="button"
        onClick={onCompose}
        style={cta}
        data-testid="empty-state-compose"
        aria-label="Compose new email"
      >
        + New email
      </button>
    </div>
  );
}

const wrap: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: "0.6rem",
  padding: "2rem 1.5rem",
  textAlign: "center",
  background: "var(--wp-dark-surface)",
  border: "1px solid var(--wp-dark-border)",
  borderRadius: 8,
  color: "var(--wp-text-dim)",
};

const iconWrap: React.CSSProperties = {
  width: 72,
  height: 72,
  borderRadius: 36,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "var(--wp-dark-surface2)",
  border: "1px solid var(--wp-dark-border)",
};

const heading: React.CSSProperties = {
  margin: 0,
  fontSize: "1rem",
  fontWeight: 600,
  color: "var(--wp-text)",
};

const body: React.CSSProperties = {
  margin: 0,
  maxWidth: 320,
  fontSize: "0.85rem",
  color: "var(--wp-text-dim)",
  lineHeight: 1.45,
};

const cta: React.CSSProperties = {
  marginTop: "0.4rem",
  background: "var(--wp-gold)",
  color: "var(--wp-dark)",
  border: "none",
  borderRadius: 6,
  padding: "0.5rem 1rem",
  fontSize: "0.82rem",
  fontWeight: 700,
  cursor: "pointer",
};
