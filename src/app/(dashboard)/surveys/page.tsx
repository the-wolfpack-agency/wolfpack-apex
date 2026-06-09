"use client";

/**
 * /surveys — internal survey BUILDER.
 *
 * Lets the team build short surveys (a small JSON schema of questions),
 * publish them at the public responder /s/<slug>, optionally link a QR
 * code so a printed asset points straight at the survey, and read the
 * aggregated results.
 *
 * Surveys are owned in-house (no third-party SaaS) — see
 * src/lib/surveys/types.ts for the schema. The five question types there
 * cover the ~80% the agency actually runs.
 *
 * Auth: redirects unauthenticated visitors to /login?next=/surveys
 * BEFORE rendering, per the dashboard convention. We never render an
 * empty 200 page when the user has no token (the April 16 blank-dashboard
 * incident class).
 *
 * Conventions cloned from /qr: getInstinctToken auth gate + redirect,
 * fetchWithRefresh / jsonHeaders for every authed call (never raw fetch),
 * the var(--wp-*) dark/gold theme tokens, SectionCard layout, and the
 * loading / empty states.
 */

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  fetchWithRefresh,
  jsonHeaders,
  getInstinctToken,
} from "@/lib/client-auth";
import type {
  Survey,
  SurveyQuestion,
  QuestionType,
  VisibleIf,
} from "@/lib/surveys/types";
import { QUESTION_TYPES, CONTENT_QUESTION_TYPES } from "@/lib/surveys/types";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

/* One question row in the create-form builder, before it's assembled
   into a SurveyQuestion. The comma-separated `optionsText` is parsed at
   submit time into the `options` array. Optional capabilities are held as
   strings/flags here and only emitted onto the built question when set, so
   blank inputs never produce undefined/empty fields in the schema. */
interface DraftQuestion {
  label: string;
  type: QuestionType;
  required: boolean;
  optionsText: string;
  /** Sub-prompt shown under the label (e.g. "Select one"). */
  helpText: string;
  /** single_choice / multiple_choice: offer an "Other ___" capture. */
  allowOther: boolean;
  /** multiple_choice: cap selections; blank string = no cap. */
  maxSelectionsText: string;
  /** section content paragraph. */
  body: string;
  /** "visible only if": the controlling earlier question id (blank = none). */
  visibleIfQuestionId: string;
  /** the value the controlling question must equal to show this one. */
  visibleIfValue: string;
}

/* Per-question insight from GET /api/surveys/:id/insights → insights.perQuestion.
   The shape is owned by @/lib/surveys/insights (computeInsights →
   aggregateResponses); we render defensively so a question with only some of
   the fields (option counts, a rating average, free-text + Other samples)
   surfaces without the panel blowing up. */
interface QuestionInsight {
  questionId?: string;
  label?: string;
  type?: string;
  /** total answers to this question. */
  answered?: number;
  /** choice questions → { option: count }. */
  optionCounts?: Record<string, number>;
  /** choice questions with allowOther → count of write-in answers. */
  otherCount?: number;
  /** choice questions with allowOther → sample write-in answers. */
  otherSamples?: string[];
  /** rating questions → numeric average. */
  average?: number;
  /** free-text / email questions → sample answers. */
  textSamples?: string[];
}

/* The funnel + completion metrics a form SaaS doesn't surface, from
   GET /api/surveys/:id/insights → insights. We read defensively (every
   field optional) so a partial payload never blanks the panel. */
interface SurveyInsights {
  views?: number;
  responses?: number;
  /** responses / views, 0..1. */
  completionRate?: number;
  /** mean time-on-form in ms, or null when nobody reported a duration. */
  avgDurationMs?: number | null;
  firstResponseAt?: string | null;
  lastResponseAt?: string | null;
  byDevice?: Record<string, number>;
  byCountry?: Record<string, number>;
  byReferrer?: Record<string, number>;
  perQuestion?: QuestionInsight[];
}

interface ResultsState {
  loading: boolean;
  error: string | null;
  insights: SurveyInsights | null;
}

interface RowState {
  busy: boolean;
  error: string | null;
  resultsOpen: boolean;
  results: ResultsState;
  qrOpen: boolean;
  qrLoading: boolean;
  qrSvg: string | null;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function rerouteToLogin() {
  if (typeof window === "undefined") return;
  window.location.href = "/login?next=/surveys";
}

const CHOICE_TYPES: ReadonlySet<QuestionType> = new Set<QuestionType>([
  "single_choice",
  "multiple_choice",
]);

/* Content blocks (sections) collect no answer — they can't be required and
   are valid controllers for "visible only if". */
const CONTENT_TYPES: ReadonlySet<QuestionType> = new Set<QuestionType>(
  CONTENT_QUESTION_TYPES,
);

/* Human label for a question type — the team isn't technical, so the
   <select> shows plain language rather than the snake_case enum. */
const TYPE_LABELS: Record<QuestionType, string> = {
  short_text: "Short text",
  long_text: "Long text",
  single_choice: "Single choice",
  multiple_choice: "Multiple choice",
  rating: "Rating (1–5)",
  email: "Email",
  section: "Section heading (no answer)",
};

function parseOptions(text: string): string[] {
  return text
    .split(",")
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
}

function newDraftQuestion(type: QuestionType = "short_text"): DraftQuestion {
  return {
    label: "",
    type,
    required: false,
    optionsText: "",
    helpText: "",
    allowOther: false,
    maxSelectionsText: "",
    body: "",
    visibleIfQuestionId: "",
    visibleIfValue: "",
  };
}

/* Positional, stable id for the question at index `i` (q1, q2 …). The
   responder + aggregate key on these, and "visible only if" references an
   EARLIER question by this same id. */
function questionId(i: number): string {
  return `q${i + 1}`;
}

function defaultRowState(): RowState {
  return {
    busy: false,
    error: null,
    resultsOpen: false,
    results: { loading: false, error: null, insights: null },
    qrOpen: false,
    qrLoading: false,
    qrSvg: null,
  };
}

/* Format a duration in ms as a friendly "Ns" for non-technical staff; an
   absent duration (nobody timed) reads "N/A". */
function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "N/A";
  const secs = Math.round(ms / 1000);
  return `${secs}s`;
}

/* completionRate (0..1) → a whole-percent string for the UI. */
function formatPercent(rate: number | null | undefined): string {
  if (rate === null || rate === undefined || !Number.isFinite(rate)) return "0%";
  return `${Math.round(rate * 100)}%`;
}

/* ------------------------------------------------------------------ */
/* Section card (cloned from /qr)                                      */
/* ------------------------------------------------------------------ */

function SectionCard({
  title,
  children,
  testId,
}: {
  title: string;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <div
      data-testid={testId}
      className="rounded-lg border p-5"
      style={{
        background: "var(--wp-dark-surface)",
        borderColor: "var(--wp-dark-border)",
      }}
    >
      <h2
        className="text-sm font-semibold mb-4"
        style={{ color: "var(--wp-gold)" }}
      >
        {title}
      </h2>
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

export default function SurveysPage() {
  const [authChecked, setAuthChecked] = useState(false);
  const [surveys, setSurveys] = useState<Survey[]>([]);
  const [rowStates, setRowStates] = useState<Record<string, RowState>>({});
  const [loadingList, setLoadingList] = useState(true);
  const [listError, setListError] = useState<string | null>(null);

  /* Create-form state */
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [questions, setQuestions] = useState<DraftQuestion[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  /* ── auth gate (identical to /qr) ─────────────────────────────── */
  useEffect(() => {
    if (!getInstinctToken()) {
      rerouteToLogin();
      return;
    }
    setAuthChecked(true);
  }, []);

  /* ── initial list ─────────────────────────────────────────────── */
  const loadList = useCallback(async () => {
    setLoadingList(true);
    setListError(null);
    try {
      const res = await fetchWithRefresh("/api/surveys");
      if (!res.ok) {
        setListError("We couldn't load your surveys. Please refresh.");
        return;
      }
      const data = (await res.json()) as { surveys: Survey[] };
      setSurveys(Array.isArray(data.surveys) ? data.surveys : []);
    } catch (err) {
      setListError(`Failed to load surveys: ${(err as Error).message}`);
    } finally {
      setLoadingList(false);
    }
  }, []);

  useEffect(() => {
    if (!authChecked) return;
    void loadList();
  }, [authChecked, loadList]);

  /* ── create-form question builder ─────────────────────────────── */
  function addQuestion(type: QuestionType = "short_text") {
    setQuestions((prev) => [...prev, newDraftQuestion(type)]);
  }

  function patchQuestion(idx: number, patch: Partial<DraftQuestion>) {
    setQuestions((prev) =>
      prev.map((q, i) => (i === idx ? { ...q, ...patch } : q)),
    );
  }

  function removeQuestion(idx: number) {
    setQuestions((prev) => prev.filter((_, i) => i !== idx));
  }

  function resetForm() {
    setTitle("");
    setDescription("");
    setQuestions([]);
    setCreateError(null);
  }

  /* Assemble the draft rows into a SurveySchema. Question ids are stable
     and positional (q1, q2 …) so the responder + aggregate can key on
     them; choice options come from the comma-separated input. */
  function buildSchema(): { questions: SurveyQuestion[] } {
    /* Ids of questions that appear EARLIER than index i — the only valid
       targets for a "visible only if" reference (validateSchema enforces
       earlier-only). */
    return {
      questions: questions.map((q, i) => {
        const isContent = CONTENT_TYPES.has(q.type);
        const built: SurveyQuestion = {
          id: questionId(i),
          type: q.type,
          label: q.label.trim(),
          // Sections can never be required and carry no answer.
          required: isContent ? false : q.required,
        };

        const help = q.helpText.trim();
        if (help) built.helpText = help;

        if (isContent) {
          const body = q.body.trim();
          if (body) built.body = body;
          // Sections take no options / conditions / answer fields.
          return built;
        }

        if (CHOICE_TYPES.has(q.type)) {
          built.options = parseOptions(q.optionsText);
          if (q.allowOther) built.allowOther = true;
        }

        if (q.type === "multiple_choice") {
          const cap = Number(q.maxSelectionsText.trim());
          if (
            q.maxSelectionsText.trim() !== "" &&
            Number.isInteger(cap) &&
            cap >= 1
          ) {
            built.maxSelections = cap;
          }
        }

        // "Visible only if" — only emit when the referenced question is an
        // EARLIER one and a value is supplied. Controllers are single-value
        // here, so we always use `equals`.
        const controllerId = q.visibleIfQuestionId.trim();
        const controllerVal = q.visibleIfValue.trim();
        if (controllerId && controllerVal) {
          const controllerIdx = questions.findIndex(
            (_, j) => questionId(j) === controllerId,
          );
          if (controllerIdx >= 0 && controllerIdx < i) {
            const visibleIf: VisibleIf = {
              questionId: controllerId,
              equals: controllerVal,
            };
            built.visibleIf = visibleIf;
          }
        }

        return built;
      }),
    };
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) {
      setCreateError("A title is required.");
      return;
    }
    if (questions.length === 0) {
      setCreateError("Add at least one question.");
      return;
    }
    if (questions.some((q) => !q.label.trim())) {
      setCreateError("Every question needs a label.");
      return;
    }
    setSubmitting(true);
    setCreateError(null);
    try {
      const body: {
        title: string;
        description?: string;
        schema: { questions: SurveyQuestion[] };
      } = {
        title: title.trim(),
        schema: buildSchema(),
      };
      if (description.trim()) body.description = description.trim();
      const res = await fetchWithRefresh("/api/surveys", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const errBody = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        setCreateError(errBody.error ?? "Failed to create survey.");
        return;
      }
      const data = (await res.json()) as { survey: Survey };
      setSurveys((prev) => [data.survey, ...prev]);
      setRowStates((prev) => ({
        ...prev,
        [data.survey.id]: defaultRowState(),
      }));
      resetForm();
    } catch (err) {
      setCreateError(`Network error: ${(err as Error).message}`);
    } finally {
      setSubmitting(false);
    }
  }

  /* ── row helpers ──────────────────────────────────────────────── */
  function getRow(id: string): RowState {
    return rowStates[id] ?? defaultRowState();
  }

  function patchRow(id: string, patch: Partial<RowState>) {
    setRowStates((prev) => {
      const current = prev[id] ?? defaultRowState();
      return { ...prev, [id]: { ...current, ...patch } };
    });
  }

  function patchResults(id: string, patch: Partial<ResultsState>) {
    setRowStates((prev) => {
      const current = prev[id] ?? defaultRowState();
      return {
        ...prev,
        [id]: { ...current, results: { ...current.results, ...patch } },
      };
    });
  }

  /* Publish / Close toggle. A draft or closed survey publishes; a
     published survey closes. The server is the source of truth — we
     update the row in place from its response. */
  async function toggleStatus(survey: Survey) {
    const nextStatus: "published" | "closed" =
      survey.status === "published" ? "closed" : "published";
    patchRow(survey.id, { busy: true, error: null });
    try {
      const res = await fetchWithRefresh(
        `/api/surveys/${encodeURIComponent(survey.id)}`,
        {
          method: "PATCH",
          headers: jsonHeaders(),
          body: JSON.stringify({ status: nextStatus }),
        },
      );
      if (!res.ok) {
        const errBody = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        patchRow(survey.id, {
          busy: false,
          error: errBody.error ?? "Failed to update status.",
        });
        return;
      }
      const data = (await res.json()) as { survey: Survey };
      setSurveys((prev) =>
        prev.map((s) => (s.id === survey.id ? data.survey : s)),
      );
      patchRow(survey.id, { busy: false, error: null });
    } catch (err) {
      patchRow(survey.id, {
        busy: false,
        error: `Network error: ${(err as Error).message}`,
      });
    }
  }

  /* Link a QR code to this survey so a printed asset points at /s/<slug>.
     POST :id/qr returns the updated survey (now carrying qrCodeId). */
  async function generateQr(survey: Survey) {
    patchRow(survey.id, { busy: true, error: null });
    try {
      const res = await fetchWithRefresh(
        `/api/surveys/${encodeURIComponent(survey.id)}/qr`,
        { method: "POST", headers: jsonHeaders() },
      );
      if (!res.ok) {
        const errBody = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        patchRow(survey.id, {
          busy: false,
          error: errBody.error ?? "Failed to generate QR code.",
        });
        return;
      }
      const data = (await res.json()) as {
        code?: unknown;
        survey: Survey;
      };
      setSurveys((prev) =>
        prev.map((s) => (s.id === survey.id ? data.survey : s)),
      );
      patchRow(survey.id, { busy: false, error: null });
    } catch (err) {
      patchRow(survey.id, {
        busy: false,
        error: `Network error: ${(err as Error).message}`,
      });
    }
  }

  /* Show/hide the linked QR inline. The QR image is rendered on demand
     from the QR module's SVG endpoint (survey.qrCodeId), so the operator
     can see + scan it here without leaving for /qr. */
  async function toggleSurveyQr(survey: Survey) {
    const row = getRow(survey.id);
    if (row.qrOpen) {
      patchRow(survey.id, { qrOpen: false });
      return;
    }
    if (!survey.qrCodeId) return;
    if (row.qrSvg) {
      patchRow(survey.id, { qrOpen: true });
      return;
    }
    patchRow(survey.id, { qrOpen: true, qrLoading: true });
    try {
      const res = await fetchWithRefresh(
        `/api/qr/${encodeURIComponent(survey.qrCodeId)}/svg?size=180`,
      );
      if (!res.ok) {
        patchRow(survey.id, { qrLoading: false, qrSvg: "" });
        return;
      }
      const svg = await res.text();
      patchRow(survey.id, { qrLoading: false, qrSvg: svg });
    } catch {
      patchRow(survey.id, { qrLoading: false, qrSvg: "" });
    }
  }

  async function loadResults(survey: Survey) {
    patchResults(survey.id, { loading: true, error: null });
    try {
      const res = await fetchWithRefresh(
        `/api/surveys/${encodeURIComponent(survey.id)}/insights`,
      );
      if (!res.ok) {
        patchResults(survey.id, {
          loading: false,
          error: "Failed to load results.",
        });
        return;
      }
      const data = (await res.json()) as { insights?: SurveyInsights };
      patchResults(survey.id, {
        loading: false,
        insights: data.insights ?? {},
      });
    } catch (err) {
      patchResults(survey.id, {
        loading: false,
        error: `Network error: ${(err as Error).message}`,
      });
    }
  }

  function toggleResults(survey: Survey) {
    const row = getRow(survey.id);
    const next = !row.resultsOpen;
    patchRow(survey.id, { resultsOpen: next });
    if (next && row.results.insights === null && !row.results.loading) {
      void loadResults(survey);
    }
  }

  async function deleteSurvey(survey: Survey) {
    if (typeof window !== "undefined") {
      const ok = window.confirm(
        `Delete "${survey.title}"? This removes the survey and its responses. This can't be undone.`,
      );
      if (!ok) return;
    }
    patchRow(survey.id, { busy: true, error: null });
    try {
      const res = await fetchWithRefresh(
        `/api/surveys/${encodeURIComponent(survey.id)}`,
        { method: "DELETE" },
      );
      if (!res.ok) {
        patchRow(survey.id, { busy: false, error: "Failed to delete survey." });
        return;
      }
      setSurveys((prev) => prev.filter((s) => s.id !== survey.id));
    } catch (err) {
      patchRow(survey.id, {
        busy: false,
        error: `Network error: ${(err as Error).message}`,
      });
    }
  }

  /* ── render ───────────────────────────────────────────────────── */

  if (!authChecked) {
    return (
      <div
        data-testid="surveys-page-loading"
        style={{ color: "var(--wp-text-dim)" }}
      >
        Loading…
      </div>
    );
  }

  return (
    <div
      data-testid="surveys-page"
      style={{
        display: "grid",
        gap: "1.5rem",
        maxWidth: "100%",
        minWidth: 0,
        overflowX: "hidden",
        padding: "0 1rem",
      }}
    >
      <style jsx global>{`
        [data-testid="surveys-page"] h1 {
          font-size: 1.5rem;
          line-height: 1.2;
          word-break: break-word;
          overflow-wrap: anywhere;
        }
        [data-testid="surveys-page"] input,
        [data-testid="surveys-page"] textarea,
        [data-testid="surveys-page"] select {
          max-width: 100%;
          min-width: 0;
          box-sizing: border-box;
        }
        [data-testid="surveys-page"] .survey-q-grid {
          display: grid;
          gap: 0.5rem;
          grid-template-columns: 1fr 12rem;
          align-items: start;
        }
        @media (max-width: 640px) {
          [data-testid="surveys-page"] {
            padding: 0 0.75rem;
          }
          [data-testid="surveys-page"] h1 {
            font-size: 1.25rem;
          }
          [data-testid="surveys-page"] .survey-q-grid {
            grid-template-columns: 1fr;
          }
          [data-testid="surveys-page"] code,
          [data-testid="surveys-page"] strong {
            word-break: break-all;
            overflow-wrap: anywhere;
          }
        }
      `}</style>

      <header>
        <h1
          className="text-2xl font-bold mb-1"
          style={{ color: "var(--wp-gold)" }}
        >
          Surveys
        </h1>
        <p
          style={{
            color: "var(--wp-text-dim)",
            fontSize: "0.875rem",
            margin: 0,
          }}
        >
          Build a short survey, share its public link, and read the results.
          Add a QR code to put it on a poster or handout. Publish when it&apos;s
          ready, close it when you&apos;re done.
        </p>
      </header>

      {/* ── Create form ─────────────────────────────────────────── */}
      <SectionCard title="Build a new survey" testId="survey-create-section">
        <form
          data-testid="survey-create-form"
          onSubmit={handleCreate}
          style={{ display: "grid", gap: "0.75rem" }}
        >
          <label style={{ display: "grid", gap: 4, minWidth: 0 }}>
            <span style={{ fontSize: "0.75rem", color: "var(--wp-text-dim)" }}>
              Title <span style={{ color: "var(--wp-error)" }}>*</span>
            </span>
            <input
              data-testid="survey-create-title"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Post-event feedback"
              style={inputStyle}
            />
          </label>

          <label style={{ display: "grid", gap: 4, minWidth: 0 }}>
            <span style={{ fontSize: "0.75rem", color: "var(--wp-text-dim)" }}>
              Description (optional)
            </span>
            <textarea
              data-testid="survey-create-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="A line shown to people before they answer."
              rows={2}
              style={{ ...inputStyle, resize: "vertical" }}
            />
          </label>

          {/* Question builder */}
          <div style={{ display: "grid", gap: "0.6rem" }}>
            <div
              style={{
                fontSize: "0.75rem",
                color: "var(--wp-text-dim)",
                fontWeight: 600,
              }}
            >
              Questions
            </div>

            {questions.length === 0 ? (
              <div
                data-testid="survey-questions-empty"
                style={{ color: "var(--wp-text-muted)", fontSize: "0.8rem" }}
              >
                No questions yet — add your first one below.
              </div>
            ) : (
              <div
                data-testid="survey-questions"
                style={{ display: "grid", gap: "0.75rem" }}
              >
                {questions.map((q, i) => (
                  <div
                    key={i}
                    data-testid={`survey-question-row-${i}`}
                    style={{
                      border: "1px solid var(--wp-dark-border)",
                      borderRadius: 8,
                      padding: "0.75rem",
                      display: "grid",
                      gap: "0.5rem",
                    }}
                  >
                    <div className="survey-q-grid">
                      <label style={{ display: "grid", gap: 4, minWidth: 0 }}>
                        <span
                          style={{
                            fontSize: "0.7rem",
                            color: "var(--wp-text-dim)",
                          }}
                        >
                          {q.type === "section" ? "Section" : "Question"} {i + 1}
                        </span>
                        <input
                          data-testid={`survey-q-label-${i}`}
                          type="text"
                          value={q.label}
                          onChange={(e) =>
                            patchQuestion(i, { label: e.target.value })
                          }
                          placeholder="How was your experience?"
                          style={inputStyle}
                        />
                      </label>
                      <label style={{ display: "grid", gap: 4, minWidth: 0 }}>
                        <span
                          style={{
                            fontSize: "0.7rem",
                            color: "var(--wp-text-dim)",
                          }}
                        >
                          Type
                        </span>
                        <select
                          data-testid={`survey-q-type-${i}`}
                          value={q.type}
                          onChange={(e) =>
                            patchQuestion(i, {
                              type: e.target.value as QuestionType,
                            })
                          }
                          style={inputStyle}
                          aria-label={`Question ${i + 1} type`}
                        >
                          {QUESTION_TYPES.map((t) => (
                            <option key={t} value={t}>
                              {TYPE_LABELS[t]}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>

                    {/* Help text / sub-prompt — useful for every type
                        ("Select one", "Select up to three", intro copy). */}
                    <label style={{ display: "grid", gap: 4, minWidth: 0 }}>
                      <span
                        style={{
                          fontSize: "0.7rem",
                          color: "var(--wp-text-dim)",
                        }}
                      >
                        {CONTENT_TYPES.has(q.type)
                          ? "Sub-heading (optional)"
                          : "Helper text (optional)"}
                      </span>
                      <input
                        data-testid={`survey-q-help-${i}`}
                        type="text"
                        value={q.helpText}
                        onChange={(e) =>
                          patchQuestion(i, { helpText: e.target.value })
                        }
                        placeholder="Select one"
                        style={inputStyle}
                      />
                    </label>

                    {/* Section content paragraph. */}
                    {CONTENT_TYPES.has(q.type) ? (
                      <label style={{ display: "grid", gap: 4, minWidth: 0 }}>
                        <span
                          style={{
                            fontSize: "0.7rem",
                            color: "var(--wp-text-dim)",
                          }}
                        >
                          Section text (optional)
                        </span>
                        <textarea
                          data-testid={`survey-q-body-${i}`}
                          value={q.body}
                          onChange={(e) =>
                            patchQuestion(i, { body: e.target.value })
                          }
                          placeholder="A short paragraph shown under the heading."
                          rows={2}
                          style={{ ...inputStyle, resize: "vertical" }}
                        />
                      </label>
                    ) : null}

                    {/* Choice options + "allow Other". */}
                    {CHOICE_TYPES.has(q.type) ? (
                      <>
                        <label
                          style={{ display: "grid", gap: 4, minWidth: 0 }}
                        >
                          <span
                            style={{
                              fontSize: "0.7rem",
                              color: "var(--wp-text-dim)",
                            }}
                          >
                            Choices (comma-separated)
                          </span>
                          <input
                            data-testid={`survey-q-options-${i}`}
                            type="text"
                            value={q.optionsText}
                            onChange={(e) =>
                              patchQuestion(i, { optionsText: e.target.value })
                            }
                            placeholder="Yes, No, Maybe"
                            style={inputStyle}
                          />
                        </label>
                        <label
                          style={{
                            display: "flex",
                            gap: 6,
                            alignItems: "center",
                            fontSize: "0.75rem",
                            color: "var(--wp-text-dim)",
                          }}
                        >
                          <input
                            data-testid={`survey-q-allowother-${i}`}
                            type="checkbox"
                            checked={q.allowOther}
                            onChange={(e) =>
                              patchQuestion(i, { allowOther: e.target.checked })
                            }
                          />
                          Add an &ldquo;Other&rdquo; write-in choice
                        </label>
                      </>
                    ) : null}

                    {/* multiple_choice: cap on how many can be picked. */}
                    {q.type === "multiple_choice" ? (
                      <label style={{ display: "grid", gap: 4, minWidth: 0 }}>
                        <span
                          style={{
                            fontSize: "0.7rem",
                            color: "var(--wp-text-dim)",
                          }}
                        >
                          Max selections (optional — blank = no limit)
                        </span>
                        <input
                          data-testid={`survey-q-maxselections-${i}`}
                          type="number"
                          min={1}
                          step={1}
                          value={q.maxSelectionsText}
                          onChange={(e) =>
                            patchQuestion(i, {
                              maxSelectionsText: e.target.value,
                            })
                          }
                          placeholder="e.g. 3"
                          style={inputStyle}
                        />
                      </label>
                    ) : null}

                    {/* "Visible only if" — controlled by an EARLIER question.
                        Sections take no condition (they always show). */}
                    {!CONTENT_TYPES.has(q.type) && i > 0 ? (
                      <div className="survey-q-grid">
                        <label
                          style={{ display: "grid", gap: 4, minWidth: 0 }}
                        >
                          <span
                            style={{
                              fontSize: "0.7rem",
                              color: "var(--wp-text-dim)",
                            }}
                          >
                            Show only if (optional)
                          </span>
                          <select
                            data-testid={`survey-q-visibleif-q-${i}`}
                            value={q.visibleIfQuestionId}
                            onChange={(e) =>
                              patchQuestion(i, {
                                visibleIfQuestionId: e.target.value,
                              })
                            }
                            style={inputStyle}
                            aria-label={`Question ${i + 1} shows only if`}
                          >
                            <option value="">Always show</option>
                            {questions.slice(0, i).map((earlier, j) =>
                              CONTENT_TYPES.has(earlier.type) ? null : (
                                <option key={j} value={questionId(j)}>
                                  {earlier.label.trim() ||
                                    `Question ${j + 1}`}
                                </option>
                              ),
                            )}
                          </select>
                        </label>
                        <label
                          style={{ display: "grid", gap: 4, minWidth: 0 }}
                        >
                          <span
                            style={{
                              fontSize: "0.7rem",
                              color: "var(--wp-text-dim)",
                            }}
                          >
                            …equals this answer
                          </span>
                          <input
                            data-testid={`survey-q-visibleif-val-${i}`}
                            type="text"
                            value={q.visibleIfValue}
                            onChange={(e) =>
                              patchQuestion(i, {
                                visibleIfValue: e.target.value,
                              })
                            }
                            placeholder="Yes"
                            style={inputStyle}
                            disabled={!q.visibleIfQuestionId}
                          />
                        </label>
                      </div>
                    ) : null}

                    <div
                      style={{
                        display: "flex",
                        gap: 12,
                        alignItems: "center",
                        flexWrap: "wrap",
                      }}
                    >
                      {/* Sections collect no answer, so "required" is hidden. */}
                      {CONTENT_TYPES.has(q.type) ? null : (
                        <label
                          style={{
                            display: "flex",
                            gap: 6,
                            alignItems: "center",
                            fontSize: "0.75rem",
                            color: "var(--wp-text-dim)",
                          }}
                        >
                          <input
                            data-testid={`survey-q-required-${i}`}
                            type="checkbox"
                            checked={q.required}
                            onChange={(e) =>
                              patchQuestion(i, { required: e.target.checked })
                            }
                          />
                          Required
                        </label>
                      )}
                      <button
                        data-testid={`survey-q-remove-${i}`}
                        type="button"
                        onClick={() => removeQuestion(i)}
                        style={{
                          ...btnSecondary,
                          color: "var(--wp-error)",
                          borderColor: "var(--wp-error)",
                        }}
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button
                data-testid="survey-add-question"
                type="button"
                onClick={() => addQuestion()}
                style={btnSecondary}
              >
                + Add question
              </button>
              <button
                data-testid="survey-add-section"
                type="button"
                onClick={() => addQuestion("section")}
                style={btnSecondary}
                title="Add a heading + intro text between questions (no answer collected)"
              >
                + Add section
              </button>
            </div>
          </div>

          {createError ? (
            <div
              data-testid="survey-create-error"
              style={{ color: "var(--wp-error)", fontSize: "0.85rem" }}
            >
              {createError}
            </div>
          ) : null}

          <div>
            <button
              data-testid="survey-create-submit"
              type="submit"
              disabled={submitting}
              style={{
                background: "var(--wp-gold)",
                color: "#000",
                border: "none",
                padding: "0.55rem 1rem",
                borderRadius: 6,
                fontWeight: 600,
                cursor: submitting ? "not-allowed" : "pointer",
                opacity: submitting ? 0.6 : 1,
              }}
            >
              {submitting ? "Creating…" : "Create survey"}
            </button>
          </div>
        </form>
      </SectionCard>

      {/* ── List ────────────────────────────────────────────────── */}
      <SectionCard title="Your surveys" testId="survey-list-section">
        {loadingList ? (
          <div
            data-testid="surveys-list-loading"
            style={{ color: "var(--wp-text-dim)", fontSize: "0.85rem" }}
          >
            Loading surveys…
          </div>
        ) : listError ? (
          <div
            data-testid="surveys-list-error"
            style={{ color: "var(--wp-error)", fontSize: "0.85rem" }}
          >
            {listError}
          </div>
        ) : surveys.length === 0 ? (
          <div
            data-testid="surveys-empty"
            style={{ color: "var(--wp-text-muted)", fontSize: "0.9rem" }}
          >
            No surveys yet — build your first one above.
          </div>
        ) : (
          <div
            data-testid="surveys-list"
            style={{ display: "grid", gap: "0.5rem" }}
          >
            {surveys.map((s) => {
              const row = getRow(s.id);
              const linked = Boolean(s.qrCodeId);
              return (
                <div
                  key={s.id}
                  data-testid={`survey-row-${s.id}`}
                  style={{
                    border: "1px solid var(--wp-dark-border)",
                    borderRadius: 8,
                    padding: "0.85rem 1rem",
                    background: "var(--wp-dark-surface)",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      flexWrap: "wrap",
                      gap: "0.75rem",
                      alignItems: "center",
                      justifyContent: "space-between",
                    }}
                  >
                    <div style={{ minWidth: 0, flex: "1 1 55%" }}>
                      <div
                        style={{
                          color: "var(--wp-text)",
                          fontWeight: 600,
                          fontSize: "0.9rem",
                        }}
                      >
                        {s.title || (
                          <span style={{ color: "var(--wp-text-muted)" }}>
                            (untitled)
                          </span>
                        )}{" "}
                        <span
                          data-testid={`survey-row-status-${s.id}`}
                          style={{
                            fontSize: "0.7rem",
                            padding: "2px 8px",
                            borderRadius: 999,
                            marginLeft: 4,
                            background:
                              s.status === "published"
                                ? "var(--wp-gold)"
                                : "var(--wp-dark-border)",
                            color:
                              s.status === "published"
                                ? "#000"
                                : "var(--wp-text)",
                          }}
                        >
                          {s.status}
                        </span>
                        {linked ? (
                          <span
                            data-testid={`survey-row-qr-linked-${s.id}`}
                            style={{
                              fontSize: "0.7rem",
                              padding: "2px 8px",
                              borderRadius: 999,
                              marginLeft: 6,
                              background: "var(--wp-dark-border)",
                              color: "var(--wp-gold)",
                            }}
                          >
                            QR linked
                          </span>
                        ) : null}
                      </div>
                      <div
                        style={{
                          fontSize: "0.75rem",
                          color: "var(--wp-text-dim)",
                          marginTop: 2,
                          wordBreak: "break-all",
                        }}
                      >
                        Public link:{" "}
                        <span
                          data-testid={`survey-row-link-${s.id}`}
                          style={{
                            color: "var(--wp-gold)",
                            fontFamily: "monospace",
                          }}
                        >
                          /s/{s.slug}
                        </span>
                      </div>
                    </div>

                    <div
                      style={{
                        display: "flex",
                        gap: 6,
                        flexWrap: "wrap",
                        alignItems: "center",
                        minWidth: 0,
                        maxWidth: "100%",
                      }}
                    >
                      <button
                        data-testid={`survey-publish-${s.id}`}
                        type="button"
                        disabled={row.busy}
                        onClick={() => toggleStatus(s)}
                        title={
                          s.status === "published"
                            ? "Stop accepting new responses. The /s link goes to a “closed” page. Nothing is deleted — you can re-publish anytime."
                            : "Make the survey live at its public /s link so people can respond."
                        }
                        style={btnSecondary}
                      >
                        {s.status === "published"
                          ? "Unpublish"
                          : s.status === "closed"
                            ? "Re-publish"
                            : "Publish"}
                      </button>
                      <button
                        data-testid={`survey-qr-${s.id}`}
                        type="button"
                        disabled={row.busy}
                        onClick={() => (linked ? toggleSurveyQr(s) : generateQr(s))}
                        title={
                          linked
                            ? "Show the QR code that points at this survey"
                            : "Create a QR code that opens this survey when scanned"
                        }
                        style={btnSecondary}
                      >
                        {linked ? (row.qrOpen ? "Hide QR" : "Show QR") : "Generate QR"}
                      </button>
                      <button
                        data-testid={`survey-results-${s.id}`}
                        type="button"
                        onClick={() => toggleResults(s)}
                        style={btnSecondary}
                      >
                        {row.resultsOpen ? "Hide results" : "View results"}
                      </button>
                      <button
                        data-testid={`survey-delete-${s.id}`}
                        type="button"
                        disabled={row.busy}
                        onClick={() => deleteSurvey(s)}
                        style={{
                          ...btnSecondary,
                          color: "var(--wp-error)",
                          borderColor: "var(--wp-error)",
                        }}
                      >
                        Delete
                      </button>
                    </div>
                  </div>

                  {row.error ? (
                    <div
                      data-testid={`survey-row-error-${s.id}`}
                      style={{
                        color: "var(--wp-error)",
                        fontSize: "0.75rem",
                        marginTop: 6,
                      }}
                    >
                      {row.error}
                    </div>
                  ) : null}

                  {linked && row.qrOpen ? (
                    <div
                      data-testid={`survey-qr-panel-${s.id}`}
                      style={{
                        marginTop: 12,
                        padding: 12,
                        border: "1px solid var(--wp-dark-border)",
                        borderRadius: 6,
                        display: "flex",
                        gap: 16,
                        alignItems: "center",
                        flexWrap: "wrap",
                        boxSizing: "border-box",
                        minWidth: 0,
                        maxWidth: "100%",
                        overflowX: "hidden",
                      }}
                    >
                      {row.qrSvg ? (
                        <div
                          data-testid={`survey-qr-svg-${s.id}`}
                          style={{
                            width: 160,
                            maxWidth: "100%",
                            aspectRatio: "1 / 1",
                            background: "#fff",
                            padding: 8,
                            borderRadius: 4,
                            boxSizing: "border-box",
                            flexShrink: 0,
                            overflow: "hidden",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                          }}
                          dangerouslySetInnerHTML={{
                            __html: row.qrSvg.replace(
                              /<svg([^>]*)>/,
                              '<svg$1 style="max-width:100%;max-height:100%;height:auto;display:block">',
                            ),
                          }}
                        />
                      ) : (
                        <div style={{ color: "var(--wp-text-dim)", fontSize: 13 }}>
                          {row.qrLoading ? "Loading QR…" : "Couldn’t load the QR image."}
                        </div>
                      )}
                      <div style={{ display: "grid", gap: 8, minWidth: 0 }}>
                        <span style={{ fontSize: 12, color: "var(--wp-text-dim)" }}>
                          Scans open{" "}
                          <span style={{ color: "var(--wp-gold)", fontFamily: "monospace" }}>
                            /s/{s.slug}
                          </span>
                        </span>
                        <Link
                          data-testid={`survey-qr-manage-${s.id}`}
                          href="/qr"
                          style={{
                            fontSize: 13,
                            color: "var(--wp-gold)",
                            textDecoration: "underline",
                          }}
                        >
                          Manage in QR Codes →
                        </Link>
                      </div>
                    </div>
                  ) : null}

                  {row.resultsOpen ? (
                    <div
                      data-testid={`survey-results-panel-${s.id}`}
                      style={{
                        marginTop: 12,
                        padding: 12,
                        border: "1px solid var(--wp-dark-border)",
                        borderRadius: 6,
                        display: "grid",
                        gap: 12,
                        // Keep the panel + its grids inside the card on mobile.
                        boxSizing: "border-box",
                        minWidth: 0,
                        maxWidth: "100%",
                        overflowX: "hidden",
                      }}
                    >
                      {row.results.loading ? (
                        <div
                          data-testid={`survey-results-loading-${s.id}`}
                          style={{ color: "var(--wp-text-dim)" }}
                        >
                          Loading results…
                        </div>
                      ) : row.results.error ? (
                        <div
                          data-testid={`survey-results-error-${s.id}`}
                          style={{ color: "var(--wp-error)" }}
                        >
                          {row.results.error}
                        </div>
                      ) : (
                        <>
                          <FunnelMetrics
                            surveyId={s.id}
                            insights={row.results.insights ?? {}}
                          />
                          <ResultsAggregate
                            surveyId={s.id}
                            schema={s.schema?.questions ?? []}
                            perQuestion={row.results.insights?.perQuestion ?? []}
                          />
                        </>
                      )}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </SectionCard>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Funnel metrics — the view→completion story a form SaaS hides.        */
/* ------------------------------------------------------------------ */

/* One headline number in the funnel strip. */
function Metric({
  label,
  value,
  testId,
}: {
  label: string;
  value: string;
  testId: string;
}) {
  return (
    <div
      style={{
        border: "1px solid var(--wp-dark-border)",
        borderRadius: 6,
        padding: "0.5rem 0.65rem",
        display: "grid",
        gap: 2,
        minWidth: 0,
        // border-box so the padding doesn't push the card past its grid
        // track (apex has no global box-sizing reset) — the same overflow
        // class we fixed on the QR "Show QR" box.
        boxSizing: "border-box",
        overflowWrap: "anywhere",
      }}
    >
      <div
        data-testid={testId}
        style={{
          color: "var(--wp-text)",
          fontWeight: 700,
          fontSize: "1.05rem",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {value}
      </div>
      <div
        style={{
          color: "var(--wp-text-dim)",
          fontSize: "0.7rem",
        }}
      >
        {label}
      </div>
    </div>
  );
}

/* A small attribution breakdown (device / source / country) shown as a
   compact "label: count" list. Skipped when there's nothing to show. */
function Breakdown({ title, data }: { title: string; data?: Record<string, number> }) {
  const entries = Object.entries(data ?? {}).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return null;
  return (
    <div style={{ display: "grid", gap: 3, minWidth: 0 }}>
      <div style={{ color: "var(--wp-text-dim)", fontSize: "0.7rem", fontWeight: 600 }}>
        {title}
      </div>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 6,
          fontSize: "0.7rem",
          color: "var(--wp-text-dim)",
        }}
      >
        {entries.map(([k, v]) => (
          <span
            key={k}
            style={{
              border: "1px solid var(--wp-dark-border)",
              borderRadius: 999,
              padding: "1px 8px",
            }}
          >
            {k}: <strong style={{ color: "var(--wp-text)" }}>{v}</strong>
          </span>
        ))}
      </div>
    </div>
  );
}

function FunnelMetrics({
  surveyId,
  insights,
}: {
  surveyId: string;
  insights: SurveyInsights;
}) {
  const views = insights.views ?? 0;
  const responses = insights.responses ?? 0;
  return (
    <div style={{ display: "grid", gap: 10, minWidth: 0 }}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(7rem, 1fr))",
          gap: 8,
          minWidth: 0,
        }}
      >
        <Metric
          label="People who opened it"
          value={String(views)}
          testId={`survey-insights-views-${surveyId}`}
        />
        <Metric
          label={`Response${responses === 1 ? "" : "s"} received`}
          value={String(responses)}
          testId={`survey-insights-responses-${surveyId}`}
        />
        <Metric
          label="Completion rate"
          value={formatPercent(insights.completionRate)}
          testId={`survey-insights-completion-${surveyId}`}
        />
        <Metric
          label="Avg. time to finish"
          value={formatDuration(insights.avgDurationMs)}
          testId={`survey-insights-avgtime-${surveyId}`}
        />
      </div>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 16,
        }}
      >
        <Breakdown title="By device" data={insights.byDevice} />
        <Breakdown title="By source" data={insights.byReferrer} />
        <Breakdown title="By country" data={insights.byCountry} />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Results aggregate — renders the per-question summary defensively.    */
/* ------------------------------------------------------------------ */

function ResultsAggregate({
  surveyId,
  schema,
  perQuestion,
}: {
  surveyId: string;
  schema: SurveyQuestion[];
  perQuestion: QuestionInsight[];
}) {
  if (perQuestion.length === 0) {
    return (
      <div
        data-testid={`survey-results-empty-${surveyId}`}
        style={{ color: "var(--wp-text-muted)", fontSize: "0.85rem" }}
      >
        No responses yet.
      </div>
    );
  }
  /* Index the schema so we can fall back to the question's own label /
     type when the per-question row doesn't echo them. */
  const byId = new Map(schema.map((q) => [q.id, q]));
  return (
    <div style={{ display: "grid", gap: 12 }}>
      {perQuestion.map((agg, i) => {
        const q = agg.questionId ? byId.get(agg.questionId) : undefined;
        const label = agg.label ?? q?.label ?? `Question ${i + 1}`;
        const counts = agg.optionCounts ?? {};
        const countEntries = Object.entries(counts);
        const max = Math.max(1, ...countEntries.map(([, c]) => c));
        const otherSamples = agg.otherSamples ?? [];
        const textSamples = agg.textSamples ?? [];
        return (
          <div
            key={agg.questionId ?? i}
            data-testid={`survey-results-q-${surveyId}-${i}`}
            style={{ display: "grid", gap: 6 }}
          >
            <div
              style={{
                fontSize: "0.8rem",
                color: "var(--wp-text)",
                fontWeight: 600,
              }}
            >
              {label}
              {typeof agg.answered === "number" ? (
                <span
                  style={{
                    marginLeft: 6,
                    color: "var(--wp-text-muted)",
                    fontWeight: 400,
                    fontSize: "0.7rem",
                  }}
                >
                  ({agg.answered} answered)
                </span>
              ) : null}
            </div>

            {typeof agg.average === "number" ? (
              <div
                style={{ fontSize: "0.8rem", color: "var(--wp-text-dim)" }}
              >
                Average: <strong>{agg.average.toFixed(1)}</strong>
              </div>
            ) : null}

            {countEntries.length > 0 ? (
              <div style={{ display: "grid", gap: 4 }}>
                {countEntries.map(([option, count]) => (
                  <div
                    key={option}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "8rem 1fr 2.5rem",
                      gap: 6,
                      alignItems: "center",
                      fontSize: "0.75rem",
                    }}
                  >
                    <div
                      style={{
                        color: "var(--wp-text-dim)",
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                      title={option}
                    >
                      {option}
                    </div>
                    <div
                      style={{
                        background: "var(--wp-dark-border)",
                        borderRadius: 3,
                        height: 8,
                        overflow: "hidden",
                      }}
                    >
                      <div
                        style={{
                          width: `${(count / max) * 100}%`,
                          height: "100%",
                          background: "var(--wp-gold)",
                        }}
                      />
                    </div>
                    <div
                      style={{
                        color: "var(--wp-text)",
                        textAlign: "right",
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      {count}
                    </div>
                  </div>
                ))}
              </div>
            ) : null}

            {/* "Other" write-ins on a choice question. */}
            {otherSamples.length > 0 ? (
              <div style={{ display: "grid", gap: 4 }}>
                <div
                  style={{
                    color: "var(--wp-text-dim)",
                    fontSize: "0.7rem",
                    fontWeight: 600,
                  }}
                >
                  Other
                  {typeof agg.otherCount === "number"
                    ? ` (${agg.otherCount})`
                    : ""}
                </div>
                <ul
                  data-testid={`survey-results-q-${surveyId}-${i}-other`}
                  style={{
                    listStyle: "none",
                    margin: 0,
                    padding: 0,
                    display: "grid",
                    gap: 4,
                    fontSize: "0.75rem",
                    color: "var(--wp-text-dim)",
                  }}
                >
                  {otherSamples.slice(0, 20).map((ans, j) => (
                    <li
                      key={j}
                      style={{
                        borderBottom: "1px dashed var(--wp-dark-border)",
                        padding: "2px 0",
                      }}
                    >
                      {ans}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {/* Free-text / email sample answers. */}
            {textSamples.length > 0 ? (
              <ul
                style={{
                  listStyle: "none",
                  margin: 0,
                  padding: 0,
                  display: "grid",
                  gap: 4,
                  fontSize: "0.75rem",
                  color: "var(--wp-text-dim)",
                }}
              >
                {textSamples.slice(0, 20).map((ans, j) => (
                  <li
                    key={j}
                    style={{
                      borderBottom: "1px dashed var(--wp-dark-border)",
                      padding: "2px 0",
                    }}
                  >
                    {ans}
                  </li>
                ))}
              </ul>
            ) : null}

            {countEntries.length === 0 &&
            typeof agg.average !== "number" &&
            otherSamples.length === 0 &&
            textSamples.length === 0 ? (
              <div
                style={{ color: "var(--wp-text-muted)", fontSize: "0.75rem" }}
              >
                No answers yet.
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Shared styles (cloned from /qr)                                     */
/* ------------------------------------------------------------------ */

const inputStyle: React.CSSProperties = {
  background: "var(--wp-dark)",
  border: "1px solid var(--wp-dark-border)",
  color: "var(--wp-text)",
  borderRadius: 6,
  padding: "0.45rem 0.6rem",
  fontSize: "0.85rem",
};

const btnSecondary: React.CSSProperties = {
  background: "transparent",
  border: "1px solid var(--wp-dark-border)",
  color: "var(--wp-text)",
  padding: "0.35rem 0.7rem",
  borderRadius: 6,
  fontSize: "0.75rem",
  cursor: "pointer",
};
