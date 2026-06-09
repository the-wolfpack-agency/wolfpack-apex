"use client";

/**
 * ResponderForm — PUBLIC survey responder UI.
 *
 * Renders each question by type and POSTs the assembled answers to
 * /api/s/<slug>. This is a public, unauthenticated surface — raw
 * `fetch` is CORRECT here (there is no JWT/session, so the
 * fetchWithRefresh wrapper doesn't apply). The April 16 blank-dashboard
 * guardrail is about AUTHENTICATED client fetches; this page has no auth.
 *
 * Flow:
 *   - Client-side required check first (so common omissions don't burn a
 *     server round-trip), then POST.
 *   - 200 → success state (data-testid="survey-submitted"), form removed.
 *   - 400 → server validation error inline (data-testid="survey-error"),
 *           form kept so the respondent can fix and resubmit.
 *   - 429 → "too many submissions" message.
 *
 * The server (validateAnswers) is the real gate — the client checks are
 * UX only. Dark/gold Instinct theme via var(--wp-*) tokens. Mobile-first.
 */

import { useState } from "react";
import type {
  AnswerMap,
  AnswerValue,
  SurveyQuestion,
  SurveySchema,
} from "@/lib/surveys/types";

interface Props {
  slug: string;
  title: string;
  description: string | null;
  schema: SurveySchema;
}

type SubmitState = "idle" | "submitting" | "submitted";

const cardStyle: React.CSSProperties = {
  maxWidth: "40rem",
  width: "100%",
  background: "var(--wp-dark-surface, #16161d)",
  border: "1px solid var(--wp-dark-border, #2a2a35)",
  borderRadius: "12px",
  padding: "1.75rem",
  boxSizing: "border-box",
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: "0.6rem 0.75rem",
  borderRadius: 8,
  border: "1px solid var(--wp-dark-border, #2a2a35)",
  background: "var(--wp-dark, #0b0b10)",
  color: "var(--wp-text, #f4f4f5)",
  fontSize: "0.95rem",
};

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: "0.95rem",
  fontWeight: 600,
  color: "var(--wp-text, #f4f4f5)",
  marginBottom: "0.5rem",
};

function isAnswered(q: SurveyQuestion, v: AnswerValue | undefined): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v === "string") return v.trim() !== "";
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "number") return Number.isFinite(v);
  return false;
}

export default function ResponderForm({
  slug,
  title,
  description,
  schema,
}: Props) {
  const [answers, setAnswers] = useState<AnswerMap>({});
  const [state, setState] = useState<SubmitState>("idle");
  const [error, setError] = useState<string | null>(null);

  function setAnswer(id: string, value: AnswerValue | undefined) {
    setAnswers((prev) => {
      const next = { ...prev };
      if (value === undefined) delete next[id];
      else next[id] = value;
      return next;
    });
  }

  function toggleMulti(id: string, option: string, checked: boolean) {
    setAnswers((prev) => {
      const current = Array.isArray(prev[id]) ? (prev[id] as string[]) : [];
      const next = checked
        ? Array.from(new Set([...current, option]))
        : current.filter((o) => o !== option);
      const out = { ...prev };
      if (next.length === 0) delete out[id];
      else out[id] = next;
      return out;
    });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    // Client-side required check (UX only — server re-validates).
    const firstMissing = schema.questions.find(
      (q) => q.required && !isAnswered(q, answers[q.id]),
    );
    if (firstMissing) {
      setError(`"${firstMissing.label}" is required.`);
      return;
    }

    setState("submitting");
    try {
      const res = await fetch(`/api/s/${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ answers }),
      });
      if (res.status === 200) {
        setState("submitted");
        return;
      }
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (res.status === 429) {
        setError(
          "You've submitted too many times in a short window. Please try again later.",
        );
      } else {
        setError(data.error ?? "We couldn't submit your response.");
      }
      setState("idle");
    } catch {
      setError("Network error. Please check your connection and try again.");
      setState("idle");
    }
  }

  if (state === "submitted") {
    return (
      <div data-testid="survey-submitted" style={{ ...cardStyle, textAlign: "center" }}>
        <h1
          style={{
            fontSize: "1.5rem",
            fontWeight: 700,
            marginBottom: "0.75rem",
            color: "var(--wp-gold, #d4a857)",
          }}
        >
          Thank you
        </h1>
        <p
          style={{
            fontSize: "1rem",
            lineHeight: 1.6,
            color: "var(--wp-text-dim, #a1a1aa)",
            margin: 0,
          }}
        >
          Your response has been recorded. You can close this page.
        </p>
      </div>
    );
  }

  return (
    <form
      data-testid="survey-responder"
      onSubmit={handleSubmit}
      style={cardStyle}
      noValidate
    >
      <header style={{ marginBottom: "1.5rem" }}>
        <h1
          style={{
            fontSize: "1.5rem",
            fontWeight: 700,
            margin: 0,
            color: "var(--wp-gold, #d4a857)",
          }}
        >
          {title}
        </h1>
        {description ? (
          <p
            style={{
              fontSize: "0.95rem",
              lineHeight: 1.5,
              color: "var(--wp-text-dim, #a1a1aa)",
              marginTop: "0.5rem",
              marginBottom: 0,
            }}
          >
            {description}
          </p>
        ) : null}
      </header>

      <div style={{ display: "grid", gap: "1.5rem" }}>
        {schema.questions.map((q) => (
          <div key={q.id} data-testid={`survey-q-${q.id}`}>
            <span style={labelStyle}>
              {q.label}
              {q.required ? (
                <span style={{ color: "var(--wp-error, #f87171)" }}> *</span>
              ) : null}
            </span>
            {renderQuestion(q, answers, setAnswer, toggleMulti)}
          </div>
        ))}
      </div>

      {error ? (
        <div
          data-testid="survey-error"
          role="alert"
          style={{
            marginTop: "1.25rem",
            color: "var(--wp-error, #f87171)",
            fontSize: "0.9rem",
          }}
        >
          {error}
        </div>
      ) : null}

      <div style={{ marginTop: "1.5rem" }}>
        <button
          data-testid="survey-submit"
          type="submit"
          disabled={state === "submitting"}
          style={{
            background: "var(--wp-gold, #d4a857)",
            color: "#000",
            border: "none",
            padding: "0.65rem 1.4rem",
            borderRadius: 8,
            fontWeight: 600,
            fontSize: "0.95rem",
            cursor: state === "submitting" ? "not-allowed" : "pointer",
            opacity: state === "submitting" ? 0.6 : 1,
          }}
        >
          {state === "submitting" ? "Submitting…" : "Submit"}
        </button>
      </div>
    </form>
  );
}

/* ------------------------------------------------------------------ */
/* Per-type question renderers                                         */
/* ------------------------------------------------------------------ */

function renderQuestion(
  q: SurveyQuestion,
  answers: AnswerMap,
  setAnswer: (id: string, value: AnswerValue | undefined) => void,
  toggleMulti: (id: string, option: string, checked: boolean) => void,
): React.ReactNode {
  const value = answers[q.id];

  switch (q.type) {
    case "short_text":
      return (
        <input
          type="text"
          data-testid={`survey-input-${q.id}`}
          value={typeof value === "string" ? value : ""}
          onChange={(e) => setAnswer(q.id, e.target.value || undefined)}
          style={inputStyle}
        />
      );

    case "long_text":
      return (
        <textarea
          data-testid={`survey-input-${q.id}`}
          value={typeof value === "string" ? value : ""}
          onChange={(e) => setAnswer(q.id, e.target.value || undefined)}
          rows={4}
          style={{ ...inputStyle, resize: "vertical", fontFamily: "inherit" }}
        />
      );

    case "single_choice":
      return (
        <div style={{ display: "grid", gap: "0.5rem" }}>
          {(q.options ?? []).map((opt) => (
            <label
              key={opt}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.5rem",
                color: "var(--wp-text, #f4f4f5)",
                fontSize: "0.95rem",
                cursor: "pointer",
              }}
            >
              <input
                type="radio"
                name={q.id}
                data-testid={`survey-radio-${q.id}-${opt}`}
                value={opt}
                checked={value === opt}
                onChange={() => setAnswer(q.id, opt)}
              />
              {opt}
            </label>
          ))}
        </div>
      );

    case "multiple_choice": {
      const selected = Array.isArray(value) ? value : [];
      return (
        <div style={{ display: "grid", gap: "0.5rem" }}>
          {(q.options ?? []).map((opt) => (
            <label
              key={opt}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.5rem",
                color: "var(--wp-text, #f4f4f5)",
                fontSize: "0.95rem",
                cursor: "pointer",
              }}
            >
              <input
                type="checkbox"
                data-testid={`survey-checkbox-${q.id}-${opt}`}
                value={opt}
                checked={selected.includes(opt)}
                onChange={(e) => toggleMulti(q.id, opt, e.target.checked)}
              />
              {opt}
            </label>
          ))}
        </div>
      );
    }

    case "rating": {
      const max = q.max ?? 5;
      const current = typeof value === "number" ? value : 0;
      return (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem" }}>
          {Array.from({ length: max }, (_, i) => i + 1).map((n) => {
            const active = current >= n;
            return (
              <button
                key={n}
                type="button"
                data-testid={`survey-rating-${q.id}-${n}`}
                aria-pressed={value === n}
                onClick={() => setAnswer(q.id, n)}
                style={{
                  minWidth: "2.5rem",
                  padding: "0.45rem 0",
                  borderRadius: 8,
                  border: `1px solid ${
                    active ? "var(--wp-gold, #d4a857)" : "var(--wp-dark-border, #2a2a35)"
                  }`,
                  background: active
                    ? "var(--wp-gold, #d4a857)"
                    : "var(--wp-dark, #0b0b10)",
                  color: active ? "#000" : "var(--wp-text, #f4f4f5)",
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                {n}
              </button>
            );
          })}
        </div>
      );
    }

    default:
      return null;
  }
}
