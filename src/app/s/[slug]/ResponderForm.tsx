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
 * Question types:
 *   - short_text / long_text — text inputs.
 *   - single_choice / multiple_choice — radios / checkboxes, with optional
 *     "Other ___" free-text (allowOther) submitted as `${OTHER_VALUE_PREFIX}<text>`.
 *   - rating — 1..max button scale.
 *   - email — validated email input.
 *   - section — NON-input content block: heading + optional body paragraph.
 *
 * Capabilities:
 *   - helpText renders as a sub-prompt under the label.
 *   - multiple_choice maxSelections caps how many boxes can be checked
 *     (the rest disable once the cap is reached).
 *   - visibleIf gates a question on a controlling answer. Visibility is
 *     recomputed LIVE via isQuestionActive (shared with the server so
 *     client + server agree). Hidden questions don't render and aren't
 *     submitted; required-checks skip them.
 *
 * Flow:
 *   - Client-side required check first (active questions only), then POST.
 *   - 200 → success state (data-testid="survey-submitted"), form removed.
 *   - 400 → server validation error inline (data-testid="survey-error"),
 *           form kept so the respondent can fix and resubmit.
 *   - 429 → "too many submissions" message.
 *
 * The server (validateAnswers) is the real gate — the client checks are
 * UX only. Dark/gold Instinct theme via var(--wp-*) tokens. Mobile-first.
 */

import { useState } from "react";
import {
  OTHER_VALUE_PREFIX,
  type AnswerMap,
  type AnswerValue,
  type SurveyQuestion,
  type SurveySchema,
} from "@/lib/surveys/types";
import { isOtherValue, isQuestionActive, otherText } from "@/lib/surveys/validate";

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

const helpStyle: React.CSSProperties = {
  display: "block",
  fontSize: "0.825rem",
  fontWeight: 400,
  lineHeight: 1.4,
  color: "var(--wp-text-dim, #a1a1aa)",
  marginTop: "-0.25rem",
  marginBottom: "0.5rem",
};

const choiceRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
  color: "var(--wp-text, #f4f4f5)",
  fontSize: "0.95rem",
  cursor: "pointer",
};

const OTHER_LABEL = "Other";

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
  // Free text typed into an "Other" field, keyed by question id. Held
  // separately from `answers` so the box keeps its text while toggling.
  const [otherDrafts, setOtherDrafts] = useState<Record<string, string>>({});
  const [state, setState] = useState<SubmitState>("idle");
  const [error, setError] = useState<string | null>(null);

  // LIVE visibility — recomputed every render against the current answers
  // so conditional questions appear/disappear as the controlling answer
  // changes. Shared isQuestionActive keeps client + server in lockstep.
  const visible = schema.questions.filter((q) => isQuestionActive(q, answers));

  function setAnswer(id: string, value: AnswerValue | undefined) {
    setAnswers((prev) => {
      const next = { ...prev };
      if (value === undefined) delete next[id];
      else next[id] = value;
      return next;
    });
  }

  function setOtherDraft(id: string, text: string) {
    setOtherDrafts((prev) => ({ ...prev, [id]: text }));
  }

  // ----- single_choice helpers -----
  function selectOther(id: string) {
    const text = otherDrafts[id] ?? "";
    setAnswer(id, `${OTHER_VALUE_PREFIX}${text}`);
  }
  function setSingleOtherText(id: string, text: string) {
    setOtherDraft(id, text);
    setAnswer(id, `${OTHER_VALUE_PREFIX}${text}`);
  }

  // ----- multiple_choice helpers -----
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
  function toggleMultiOther(id: string, checked: boolean) {
    setAnswers((prev) => {
      const current = Array.isArray(prev[id]) ? (prev[id] as string[]) : [];
      const withoutOther = current.filter((o) => !isOtherValue(o));
      const next = checked
        ? [...withoutOther, `${OTHER_VALUE_PREFIX}${otherDrafts[id] ?? ""}`]
        : withoutOther;
      const out = { ...prev };
      if (next.length === 0) delete out[id];
      else out[id] = next;
      return out;
    });
  }
  function setMultiOtherText(id: string, text: string) {
    setOtherDraft(id, text);
    setAnswers((prev) => {
      const current = Array.isArray(prev[id]) ? (prev[id] as string[]) : [];
      const next = [
        ...current.filter((o) => !isOtherValue(o)),
        `${OTHER_VALUE_PREFIX}${text}`,
      ];
      return { ...prev, [id]: next };
    });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    // Only submit answers for currently-visible questions. A question
    // that was answered then hidden (controlling answer changed) must
    // NOT be sent — server agrees via the same isQuestionActive gate.
    const visibleIds = new Set(visible.map((q) => q.id));
    const payload: AnswerMap = {};
    for (const id of Object.keys(answers)) {
      if (visibleIds.has(id)) payload[id] = answers[id];
    }

    // Client-side required check (UX only — server re-validates). Skip
    // hidden (inactive) questions and content blocks.
    const firstMissing = visible.find(
      (q) =>
        q.type !== "section" && q.required && !isAnswered(q, payload[q.id]),
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
        body: JSON.stringify({ answers: payload }),
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
        {visible.map((q) =>
          q.type === "section" ? (
            <section key={q.id} data-testid={`survey-q-${q.id}`}>
              <h2
                style={{
                  fontSize: "1.15rem",
                  fontWeight: 700,
                  margin: 0,
                  color: "var(--wp-gold, #d4a857)",
                }}
              >
                {q.label}
              </h2>
              {q.body ? (
                <p
                  style={{
                    fontSize: "0.9rem",
                    lineHeight: 1.55,
                    color: "var(--wp-text-dim, #a1a1aa)",
                    marginTop: "0.5rem",
                    marginBottom: 0,
                  }}
                >
                  {q.body}
                </p>
              ) : null}
            </section>
          ) : (
            <div key={q.id} data-testid={`survey-q-${q.id}`}>
              <span style={labelStyle}>
                {q.label}
                {q.required ? (
                  <span style={{ color: "var(--wp-error, #f87171)" }}> *</span>
                ) : null}
              </span>
              {q.helpText ? (
                <span data-testid={`survey-help-${q.id}`} style={helpStyle}>
                  {q.helpText}
                </span>
              ) : null}
              {renderQuestion(q, answers, otherDrafts, {
                setAnswer,
                toggleMulti,
                selectOther,
                setSingleOtherText,
                toggleMultiOther,
                setMultiOtherText,
              })}
            </div>
          ),
        )}
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

interface RenderHandlers {
  setAnswer: (id: string, value: AnswerValue | undefined) => void;
  toggleMulti: (id: string, option: string, checked: boolean) => void;
  selectOther: (id: string) => void;
  setSingleOtherText: (id: string, text: string) => void;
  toggleMultiOther: (id: string, checked: boolean) => void;
  setMultiOtherText: (id: string, text: string) => void;
}

function renderQuestion(
  q: SurveyQuestion,
  answers: AnswerMap,
  otherDrafts: Record<string, string>,
  h: RenderHandlers,
): React.ReactNode {
  const value = answers[q.id];

  switch (q.type) {
    case "short_text":
      return (
        <input
          type="text"
          data-testid={`survey-input-${q.id}`}
          value={typeof value === "string" ? value : ""}
          onChange={(e) => h.setAnswer(q.id, e.target.value || undefined)}
          style={inputStyle}
        />
      );

    case "email":
      return (
        <input
          type="email"
          inputMode="email"
          autoComplete="email"
          data-testid={`survey-input-${q.id}`}
          value={typeof value === "string" ? value : ""}
          onChange={(e) => h.setAnswer(q.id, e.target.value || undefined)}
          style={inputStyle}
        />
      );

    case "long_text":
      return (
        <textarea
          data-testid={`survey-input-${q.id}`}
          value={typeof value === "string" ? value : ""}
          onChange={(e) => h.setAnswer(q.id, e.target.value || undefined)}
          rows={4}
          style={{ ...inputStyle, resize: "vertical", fontFamily: "inherit" }}
        />
      );

    case "single_choice": {
      const otherChecked = isOtherValue(value);
      return (
        <div style={{ display: "grid", gap: "0.5rem" }}>
          {(q.options ?? []).map((opt) => (
            <label key={opt} style={choiceRowStyle}>
              <input
                type="radio"
                name={q.id}
                data-testid={`survey-radio-${q.id}-${opt}`}
                value={opt}
                checked={value === opt}
                onChange={() => h.setAnswer(q.id, opt)}
              />
              {opt}
            </label>
          ))}
          {q.allowOther ? (
            <>
              <label style={choiceRowStyle}>
                <input
                  type="radio"
                  name={q.id}
                  data-testid={`survey-radio-${q.id}-__other__`}
                  checked={otherChecked}
                  onChange={() => h.selectOther(q.id)}
                />
                {OTHER_LABEL}
              </label>
              {otherChecked ? (
                <input
                  type="text"
                  data-testid={`survey-other-input-${q.id}`}
                  placeholder="Please specify"
                  value={
                    isOtherValue(value)
                      ? otherText(value)
                      : otherDrafts[q.id] ?? ""
                  }
                  onChange={(e) => h.setSingleOtherText(q.id, e.target.value)}
                  style={inputStyle}
                />
              ) : null}
            </>
          ) : null}
        </div>
      );
    }

    case "multiple_choice": {
      const selected = Array.isArray(value) ? value : [];
      const cap = q.maxSelections;
      const atCap = cap !== undefined && selected.length >= cap;
      const otherChecked = selected.some((v) => isOtherValue(v));
      return (
        <div style={{ display: "grid", gap: "0.5rem" }}>
          {(q.options ?? []).map((opt) => {
            const checked = selected.includes(opt);
            // At the cap, lock the remaining (unchecked) boxes.
            const disabled = atCap && !checked;
            return (
              <label
                key={opt}
                style={{ ...choiceRowStyle, opacity: disabled ? 0.5 : 1 }}
              >
                <input
                  type="checkbox"
                  data-testid={`survey-checkbox-${q.id}-${opt}`}
                  value={opt}
                  checked={checked}
                  disabled={disabled}
                  onChange={(e) => h.toggleMulti(q.id, opt, e.target.checked)}
                />
                {opt}
              </label>
            );
          })}
          {q.allowOther ? (
            <>
              <label
                style={{
                  ...choiceRowStyle,
                  opacity: atCap && !otherChecked ? 0.5 : 1,
                }}
              >
                <input
                  type="checkbox"
                  data-testid={`survey-checkbox-${q.id}-__other__`}
                  checked={otherChecked}
                  disabled={atCap && !otherChecked}
                  onChange={(e) => h.toggleMultiOther(q.id, e.target.checked)}
                />
                {OTHER_LABEL}
              </label>
              {otherChecked ? (
                <input
                  type="text"
                  data-testid={`survey-other-input-${q.id}`}
                  placeholder="Please specify"
                  value={otherDrafts[q.id] ?? ""}
                  onChange={(e) => h.setMultiOtherText(q.id, e.target.value)}
                  style={inputStyle}
                />
              ) : null}
            </>
          ) : null}
          {cap !== undefined ? (
            <span
              data-testid={`survey-maxhint-${q.id}`}
              style={{
                fontSize: "0.8rem",
                color: atCap
                  ? "var(--wp-gold, #d4a857)"
                  : "var(--wp-text-dim, #a1a1aa)",
              }}
            >
              {`Select up to ${cap}`}
            </span>
          ) : null}
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
                onClick={() => h.setAnswer(q.id, n)}
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
