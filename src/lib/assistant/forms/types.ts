/**
 * Chat action forms — typed structure for inline forms the Assistant
 * surfaces when a user asks for a structured action ("create email",
 * "create task", "schedule a meeting", "create message").
 *
 * Why forms vs. free-form text:
 *   - Required fields are enforced before the action fires — the user
 *     can't accidentally send an email with no recipient or a task
 *     with no title.
 *   - Each field is typed (email, date, select, ...) so the UI can
 *     render the right input + validate on submit.
 *   - Submission goes through a single /api/assistant/forms/submit
 *     proxy → the right backend endpoint, so the chat surface doesn't
 *     have to know how each integration's POST body is shaped.
 *
 * Pure data — no React. The chat UI imports this type and renders
 * ChatActionForm based on the field list. Both the tool builders
 * (server) and the form renderer (client) share the type so the
 * contract can't drift.
 */

export type FormFieldType =
  | "text"
  | "textarea"
  | "email"
  | "date"
  | "datetime-local"
  | "select";

export interface FormFieldOption {
  value: string;
  label: string;
}

export interface FormField {
  /** POST-body key the field maps to on submit. */
  name: string;
  /** Display label rendered above the input. */
  label: string;
  type: FormFieldType;
  required: boolean;
  placeholder?: string;
  /** Pre-filled value when the tool was able to extract it from the
   *  user's original phrasing (e.g. "create email to alice@..."). */
  defaultValue?: string;
  /** Required for `type: "select"`. */
  options?: FormFieldOption[];
  /** Helper text shown below the input. */
  helpText?: string;
  /** When provided, the UI enforces this client-side as a hint —
   *  server still re-validates. */
  maxLength?: number;
}

/** Discriminator for analytics + dispatch routing. */
export type FormKind =
  | "create_email"
  | "create_message"
  | "create_calendar_event"
  | "create_task";

export interface FormSpec {
  /** Stable kind id — used by the submit endpoint to dispatch. */
  formKind: FormKind;
  /** Heading rendered at the top of the form bubble. */
  title: string;
  /** Optional one-line subtitle under the title. */
  description?: string;
  fields: FormField[];
  /** Button label, e.g. "Send email" / "Create task". */
  submitLabel: string;
  /** Analytics event fired when the form is submitted (success or
   *  failure). The submit endpoint also fires its own analytics
   *  events for the underlying action. */
  analyticsEvent?: string;
}

/* ---------------------------------------------------------------------
 * Server response shape for submit (typed contract the UI can rely on).
 * Mirrors the connector tool result pattern.
 * ------------------------------------------------------------------- */

export interface FormSubmitSuccess {
  ok: true;
  /** Human-readable confirmation rendered in the chat after submit. */
  message: string;
  /** Backend-specific id (mail message id, task id, event id, ...). */
  resourceId?: string;
  /** Optional deep link to the created resource. */
  resourceUrl?: string;
}

export interface FormSubmitFailure {
  ok: false;
  /** Field-level errors keyed by field name when the failure was a
   *  validation issue. */
  fieldErrors?: Record<string, string>;
  /** Top-level error message rendered above the form. */
  message: string;
  code: "validation" | "auth" | "scope" | "rate_limit" | "internal";
}

export type FormSubmitResult = FormSubmitSuccess | FormSubmitFailure;
