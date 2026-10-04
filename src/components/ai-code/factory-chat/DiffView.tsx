"use client";
/**
 * In-chat diff review: the user reads the exact change the factory authored WITHOUT
 * leaving the UI, before they consent to open a PR. Collapsible to keep the chat
 * clean; one click to expand. Neon-styled, monospace. Presentational + pure.
 *
 * Part of the "keep everything in-UI" principle - no link-out to review a change.
 */
import { useState } from "react";
import { NEON } from "./neon";

export interface DiffStats { files: number; added: number; removed: number }

/** Pure: count files + added/removed lines from a unified diff. */
export function diffStats(diff: string): DiffStats {
  let files = 0, added = 0, removed = 0;
  for (const line of (diff || "").split("\n")) {
    if (line.startsWith("diff --git") || line.startsWith("+++ ")) {
      if (line.startsWith("diff --git")) files++;
      continue;
    }
    if (line.startsWith("+") && !line.startsWith("+++")) added++;
    else if (line.startsWith("-") && !line.startsWith("---")) removed++;
  }
  // Fallback when there are no "diff --git" headers (a bare hunk): count the +++ lines.
  if (files === 0) files = (diff.match(/^\+\+\+ /gm) || []).length || (diff.trim() ? 1 : 0);
  return { files, added, removed };
}

function lineColor(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff --git")) return NEON.textDim;
  if (line.startsWith("@@")) return NEON.accent;
  if (line.startsWith("+")) return NEON.clear;
  if (line.startsWith("-")) return NEON.blocked;
  return NEON.text;
}

export default function DiffView({ diff, defaultOpen = false }: { diff: string; defaultOpen?: boolean }): React.ReactElement | null {
  const [open, setOpen] = useState(defaultOpen);
  if (!diff || !diff.trim()) return null;
  const s = diffStats(diff);
  const lines = diff.split("\n");
  return (
    <div data-testid="diff-view" style={{ border: `1px solid ${NEON.accentDim}`, borderRadius: 10, overflow: "hidden" }}>
      <button
        type="button"
        data-testid="diff-toggle"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        style={{ width: "100%", textAlign: "left", background: "transparent", border: "none", color: NEON.text, padding: "0.5rem 0.7rem", cursor: "pointer", display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.8rem" }}
      >
        <span style={{ color: NEON.accent }}>{open ? "▾" : "▸"}</span>
        <span>Review the change</span>
        <span data-testid="diff-stats" style={{ marginLeft: "auto", fontVariantNumeric: "tabular-nums", color: NEON.textDim }}>
          {s.files} file{s.files === 1 ? "" : "s"} · <span style={{ color: NEON.clear }}>+{s.added}</span> <span style={{ color: NEON.blocked }}>-{s.removed}</span>
        </span>
      </button>
      {open && (
        <pre
          data-testid="diff-body"
          style={{ margin: 0, padding: "0.5rem 0.7rem", maxHeight: 360, overflow: "auto", background: NEON.deep, fontFamily: NEON.fontMono, fontSize: "0.74rem", lineHeight: 1.45 }}
        >
          {lines.map((l, i) => (
            <div key={i} style={{ color: lineColor(l), whiteSpace: "pre" }}>{l || " "}</div>
          ))}
        </pre>
      )}
    </div>
  );
}
