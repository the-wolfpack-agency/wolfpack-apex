/**
 * ChatActionForm — inline form rendered in the chat surface when the
 * Assistant returns a FormSpec (create email / message / calendar
 * event / task). Submit button stays disabled until every required
 * field is filled — that's the "intentionality" guard the user
 * specified: structured actions never fire on a half-typed thought.
 *
 * The component is fully self-contained: it owns its own value state,
 * client-side validation, submit lifecycle, and ack/error rendering.
 * On successful submit it surfaces a green confirmation pill and
 * disables further edits. On failure it surfaces a top-level error +
 * field-level errors and keeps the form editable for retry.
 *
 * Submission goes through /api/assistant/forms/submit which dispatches
 * to the right backend (mail/send, ms/chats/[id]/messages,
 * calendar/events, tasks).
 */

"use client";

import { useState, type ChangeEvent, type FormEvent } from "react";
import { fetchWithRefresh, jsonHeaders } from "@/lib/client-auth";
import type {
  FormSpec,
  FormField,
  FormSubmitResult,
} from "@/lib/assistant/forms/types";

export interface ChatActionFormProps {
  spec: FormSpec;
  /** Called after a successful submit so the parent (InstinctChat) can
   *  append a follow-up confirmation message. Optional. */
  onSubmitted?: (result: { ok: true; message: string; resourceId?: string }) => void;
}

interface FieldState {
  value: string;
  touched: boolean;
}

function fieldId(name: string): string {
  return `chat-form-${name}`;
}

function isEmpty(v: string): boolean {
  return v.trim().length === 0;
}

function buildInitialState(spec: FormSpec): Record<string, FieldState> {
  const out: Record<string, FieldState> = {};
  for (const f of spec.fields) {
    out[f.name] = { value: f.defaultValue ?? "", touched: false };
  }
  return out;
}

export function ChatActionForm({ spec, onSubmitted }: ChatActionFormProps) {
  const [fields, setFields] = useState<Record<string, FieldState>>(() =>
    buildInitialState(spec),
  );
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState<
    | { ok: true; message: string; resourceUrl?: string }
    | null
  >(null);
  const [topError, setTopError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const updateField = (name: string, value: string) => {
    setFields((prev) => ({
      ...prev,
      [name]: { value, touched: true },
    }));
    /* Clear stale server-side error for the field as the user edits. */
    if (fieldErrors[name]) {
      setFieldErrors((prev) => {
        const next = { ...prev };
        delete next[name];
        return next;
      });
    }
  };

  /* Required-field gate. Submit stays disabled until every required
     field has a non-empty trimmed value. This is the user's
     "intentionality" requirement — no accidental sends. */
  const allRequiredFilled = spec.fields.every((f) =>
    f.required ? !isEmpty(fields[f.name]?.value ?? "") : true,
  );

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!allRequiredFilled || submitting || submitted) return;

    setSubmitting(true);
    setTopError(null);
    setFieldErrors({});

    const payload: Record<string, string> = {};
    for (const f of spec.fields) {
      const v = fields[f.name]?.value ?? "";
      if (v.length > 0) payload[f.name] = v;
    }

    try {
      const res = await fetchWithRefresh("/api/assistant/forms/submit", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({
          formKind: spec.formKind,
          fields: payload,
        }),
      });
      const data = (await res.json()) as FormSubmitResult;
      if (data.ok) {
        setSubmitted({
          ok: true,
          message: data.message,
          ...(data.resourceUrl ? { resourceUrl: data.resourceUrl } : {}),
        });
        onSubmitted?.({
          ok: true,
          message: data.message,
          ...(data.resourceId ? { resourceId: data.resourceId } : {}),
        });
      } else {
        setTopError(data.message);
        if (data.fieldErrors) setFieldErrors(data.fieldErrors);
      }
    } catch (err) {
      setTopError(`Couldn't submit: ${(err as Error).message}`);
    } finally {
      setSubmitting(false);
    }
  }

  if (submitted) {
    return (
      <div
        data-testid={`chat-action-form-success-${spec.formKind}`}
        className="rounded-md p-3 mt-2 text-sm"
        style={{
          background: "rgba(34,197,94,0.08)",
          border: "1px solid rgba(34,197,94,0.4)",
          color: "var(--wp-success, #22c55e)",
        }}
      >
        ✓ {submitted.message}
        {submitted.resourceUrl ? (
          <>
            {" "}
            <a
              href={submitted.resourceUrl}
              target="_blank"
              rel="noreferrer noopener"
              style={{ textDecoration: "underline" }}
            >
              Open
            </a>
          </>
        ) : null}
      </div>
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      data-testid={`chat-action-form-${spec.formKind}`}
      className="mt-2 rounded-md p-3"
      style={{
        background: "var(--wp-dark-surface2, #1a1a1a)",
        border: "1px solid var(--wp-dark-border, #333)",
      }}
    >
      <div
        style={{
          fontWeight: 600,
          color: "var(--wp-gold, #eab308)",
          fontSize: 13,
          marginBottom: 2,
        }}
      >
        {spec.title}
      </div>
      {spec.description ? (
        <div
          style={{ fontSize: 11, color: "var(--wp-text-muted, #9ca3af)", marginBottom: 8 }}
        >
          {spec.description}
        </div>
      ) : null}
      {topError ? (
        <div
          data-testid={`chat-action-form-error-${spec.formKind}`}
          className="rounded p-2 mb-2 text-xs"
          style={{
            background: "rgba(239,68,68,0.08)",
            border: "1px solid rgba(239,68,68,0.4)",
            color: "var(--wp-error, #ef4444)",
          }}
        >
          {topError}
        </div>
      ) : null}
      {spec.fields.map((f) => (
        <FieldRow
          key={f.name}
          field={f}
          value={fields[f.name]?.value ?? ""}
          touched={fields[f.name]?.touched ?? false}
          serverError={fieldErrors[f.name]}
          onChange={(v) => updateField(f.name, v)}
        />
      ))}
      <button
        type="submit"
        disabled={!allRequiredFilled || submitting}
        className="mt-2 rounded-md px-3 py-2 text-sm font-medium disabled:opacity-40"
        style={{
          background: "var(--wp-gold, #eab308)",
          color: "var(--wp-dark, #111)",
          cursor: !allRequiredFilled || submitting ? "not-allowed" : "pointer",
        }}
      >
        {submitting ? "Submitting…" : spec.submitLabel}
      </button>
      {!allRequiredFilled ? (
        <span
          style={{
            marginLeft: 8,
            fontSize: 11,
            color: "var(--wp-text-muted, #9ca3af)",
          }}
        >
          Fill the required fields (marked *) to enable.
        </span>
      ) : null}
    </form>
  );
}

/* ---------------------------------------------------------------------
 * FieldRow — one labeled input. Pure presentational.
 * ------------------------------------------------------------------- */

interface FieldRowProps {
  field: FormField;
  value: string;
  touched: boolean;
  serverError?: string;
  onChange: (v: string) => void;
}

function FieldRow({ field, value, touched, serverError, onChange }: FieldRowProps) {
  const requiredMissing = field.required && touched && isEmpty(value);
  const showError = requiredMissing || Boolean(serverError);
  const errorText = serverError
    ? serverError
    : requiredMissing
    ? "Required"
    : null;

  const commonStyle = {
    width: "100%",
    background: "var(--wp-dark, #111)",
    color: "var(--wp-text, #eee)",
    border: `1px solid ${showError ? "var(--wp-error, #ef4444)" : "var(--wp-dark-border, #333)"}`,
    borderRadius: 6,
    padding: "6px 10px",
    fontSize: 13,
  } as const;

  return (
    <div style={{ marginBottom: 8 }}>
      <label
        htmlFor={fieldId(field.name)}
        style={{ display: "block", fontSize: 12, marginBottom: 2, color: "var(--wp-text-dim, #aaa)" }}
      >
        {field.label}
      </label>
      {field.type === "textarea" ? (
        <textarea
          id={fieldId(field.name)}
          data-testid={`chat-action-form-input-${field.name}`}
          value={value}
          onChange={(e: ChangeEvent<HTMLTextAreaElement>) => onChange(e.target.value)}
          placeholder={field.placeholder}
          rows={3}
          maxLength={field.maxLength}
          style={{ ...commonStyle, resize: "vertical", minHeight: 70 }}
        />
      ) : field.type === "select" ? (
        <select
          id={fieldId(field.name)}
          data-testid={`chat-action-form-input-${field.name}`}
          value={value}
          onChange={(e: ChangeEvent<HTMLSelectElement>) => onChange(e.target.value)}
          style={commonStyle}
        >
          <option value="">Pick one</option>
          {(field.options ?? []).map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      ) : (
        <input
          id={fieldId(field.name)}
          data-testid={`chat-action-form-input-${field.name}`}
          type={
            field.type === "email"
              ? "email"
              : field.type === "date"
              ? "date"
              : field.type === "datetime-local"
              ? "datetime-local"
              : "text"
          }
          value={value}
          onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
          placeholder={field.placeholder}
          maxLength={field.maxLength}
          style={commonStyle}
        />
      )}
      {field.helpText ? (
        <div style={{ fontSize: 11, color: "var(--wp-text-muted, #9ca3af)", marginTop: 2 }}>
          {field.helpText}
        </div>
      ) : null}
      {errorText ? (
        <div
          data-testid={`chat-action-form-field-error-${field.name}`}
          style={{ fontSize: 11, color: "var(--wp-error, #ef4444)", marginTop: 2 }}
        >
          {errorText}
        </div>
      ) : null}
    </div>
  );
}
