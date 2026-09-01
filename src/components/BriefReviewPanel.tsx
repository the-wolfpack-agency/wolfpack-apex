"use client";

/**
 * Paste a brief, see what the work would otherwise have to guess at.
 *
 * WHY IT SITS ON THE AGENTS PAGE
 *
 * This is where briefs are written. A checker on a page nobody visits before
 * writing a brief is a checker nobody uses, and the whole value here is that it
 * runs BEFORE the work rather than as a retrospective afterwards.
 *
 * IT IS NOT A SCORE
 *
 * There is no grade, no percentage and no color scale. Every finding is a
 * missing FACT and the question that supplies it, because the useful output is
 * the question, not a judgment about the writing. A number would invite people
 * to optimize the number.
 */

import { useCallback, useState } from "react";
import { fetchWithRefresh, jsonHeaders } from "@/lib/client-auth";
import { GlassPanel } from "@/components/console";
import type { PromptReview } from "@/lib/agents/prompt-review";

export default function BriefReviewPanel() {
  const [text, setText] = useState("");
  const [review, setReview] = useState<PromptReview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetchWithRefresh("/api/admin/prompt-review", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ text }),
      });
      if (!res.ok) {
        setError(`The review could not run (HTTP ${res.status}).`);
        return;
      }
      setReview((await res.json()) as PromptReview);
    } catch {
      setError("The review could not run.");
    } finally {
      setBusy(false);
    }
  }, [text]);

  return (
    <GlassPanel
      title="Review a brief before you hand it over"
      subtitle="Nothing here is sent to a model, and the brief is never stored. It checks for the handful of facts whose absence is what actually costs a round trip: where it has to work, how you would know it worked, what must not change, and what already exists that should be reused."
    >
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={6}
        placeholder="Paste the brief you were about to send."
        aria-label="Brief to review"
        data-testid="brief-input"
        style={textarea}
      />
      <div style={{ display: "flex", gap: "0.6rem", alignItems: "center", marginTop: "0.6rem", flexWrap: "wrap" }}>
        <button
          type="button"
          onClick={() => void run()}
          disabled={busy || text.trim().length === 0}
          style={button}
          data-testid="brief-review-run"
        >
          {busy ? "Reading…" : "Review it"}
        </button>
        {error && (
          <span role="alert" style={dim} data-testid="brief-review-error">
            {error}
          </span>
        )}
      </div>

      {review && (
        <div style={{ marginTop: "0.9rem" }} data-testid="brief-review-result">
          <p style={{ margin: "0 0 0.7rem" }} data-testid="brief-review-headline">
            {review.headline}
          </p>
          {review.findings.length > 0 && (
            <ul style={list}>
              {review.findings.map((f) => (
                <li key={f.dimension} style={row} data-testid={`brief-finding-${f.dimension}`}>
                  <strong>{f.ask}</strong>
                  <p style={{ ...dim, margin: "0.3rem 0 0", fontSize: "0.85rem" }}>{f.cost}</p>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </GlassPanel>
  );
}

const dim: React.CSSProperties = { color: "var(--wp-text-dim)", fontSize: "0.9rem" };
const list: React.CSSProperties = { listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: "0.55rem" };
const row: React.CSSProperties = {
  border: "1px solid var(--wp-border, rgba(255,255,255,0.1))",
  borderRadius: "0.6rem",
  padding: "0.65rem 0.8rem",
};
const textarea: React.CSSProperties = {
  width: "100%",
  background: "var(--wp-surface, rgba(255,255,255,0.04))",
  color: "var(--wp-text, #fff)",
  border: "1px solid var(--wp-border, rgba(255,255,255,0.15))",
  borderRadius: "0.6rem",
  padding: "0.65rem 0.8rem",
  fontFamily: "inherit",
  fontSize: "0.9rem",
  resize: "vertical",
};
const button: React.CSSProperties = {
  background: "var(--wp-accent, rgba(255,255,255,0.12))",
  color: "var(--wp-text, #fff)",
  border: "1px solid var(--wp-border, rgba(255,255,255,0.2))",
  borderRadius: "0.5rem",
  padding: "0.5rem 0.9rem",
  cursor: "pointer",
  fontSize: "0.9rem",
};
