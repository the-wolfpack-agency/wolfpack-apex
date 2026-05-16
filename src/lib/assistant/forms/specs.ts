/**
 * FormSpec builders — pure functions that return the field schema for
 * each action form. Centralized here so the test suite, the tool
 * intent matchers, and the submit endpoint share one source of truth
 * (a field added here automatically appears in the tool result, the
 * UI, AND the submit-endpoint validator).
 */

import type { FormSpec, FormField } from "./types";

/** Optional pre-filled values extracted from the user's phrasing. */
export interface FormPrefill {
  to?: string;
  subject?: string;
  bodyText?: string;
  title?: string;
  /** ISO date string for date / datetime-local fields. */
  startAt?: string;
  endAt?: string;
  dueAt?: string;
  /** Teams chat id, when "create message in chat X" was phrased
   *  with an unambiguous chat ref. */
  chatId?: string;
  /** CRM record prefill (create_crm_record form). */
  crmObjectType?: "deal" | "contact" | "account" | "task";
  crmName?: string;
  crmAmount?: string;
  crmEmail?: string;
}

function withDefault(field: FormField, value: string | undefined): FormField {
  return value ? { ...field, defaultValue: value } : field;
}

export function emailFormSpec(prefill: FormPrefill = {}): FormSpec {
  return {
    formKind: "create_email",
    title: "Create email",
    description: "Required fields are marked with *.",
    fields: [
      withDefault(
        {
          name: "to",
          label: "To *",
          type: "email",
          required: true,
          placeholder: "recipient@example.com",
          helpText: "Comma-separated for multiple recipients.",
        },
        prefill.to,
      ),
      {
        name: "cc",
        label: "Cc",
        type: "email",
        required: false,
        placeholder: "optional",
      },
      withDefault(
        {
          name: "subject",
          label: "Subject *",
          type: "text",
          required: true,
          maxLength: 200,
          placeholder: "Email subject",
        },
        prefill.subject,
      ),
      withDefault(
        {
          name: "body",
          label: "Message *",
          type: "textarea",
          required: true,
          placeholder: "Type your message...",
          helpText: "Plain text. Line breaks are preserved.",
        },
        prefill.bodyText,
      ),
    ],
    submitLabel: "Send email",
    analyticsEvent: "assistant.form_create_email_submitted",
  };
}

export function messageFormSpec(prefill: FormPrefill = {}): FormSpec {
  return {
    formKind: "create_message",
    title: "Create message",
    description: "Send a Teams message to a teammate.",
    fields: [
      withDefault(
        {
          name: "recipient",
          label: "To (username) *",
          type: "text",
          required: true,
          placeholder: "Display name or email",
          helpText:
            "Server resolves to your existing 1:1 Teams chat with that person.",
        },
        prefill.chatId,
      ),
      withDefault(
        {
          name: "body",
          label: "Message *",
          type: "textarea",
          required: true,
          placeholder: "Type your message...",
          maxLength: 4000,
        },
        prefill.bodyText,
      ),
    ],
    submitLabel: "Send message",
    analyticsEvent: "assistant.form_create_message_submitted",
  };
}

export function okrFormSpec(prefill: FormPrefill = {}): FormSpec {
  /* Compute the default quarter from the current date so the form
     starts pre-filled with the most useful value. Format: YYYY-Q[1-4]. */
  const now = new Date();
  const q = Math.floor(now.getUTCMonth() / 3) + 1;
  const defaultQuarter = `${now.getUTCFullYear()}-Q${q}`;
  return {
    formKind: "create_okr",
    title: "Create OKR",
    description: "Create a quarterly OKR with one key result.",
    fields: [
      {
        name: "quarter",
        label: "Quarter *",
        type: "text",
        required: true,
        defaultValue: defaultQuarter,
        placeholder: "YYYY-QN (e.g. 2026-Q2)",
        helpText: "Format: YYYY-Q1 / Q2 / Q3 / Q4.",
      },
      withDefault(
        {
          name: "objective",
          label: "Objective *",
          type: "text",
          required: true,
          maxLength: 200,
          placeholder: "Ship the dealer onboarding redesign",
        },
        prefill.title,
      ),
      {
        name: "kr_metric",
        label: "Key result: metric *",
        type: "text",
        required: true,
        placeholder: "Onboarding completion rate",
      },
      {
        name: "kr_target",
        label: "Key result: target *",
        type: "text",
        required: true,
        placeholder: "85",
        helpText: "Numeric target (e.g. 85, 1000000).",
      },
      {
        name: "kr_unit",
        label: "Key result: unit",
        type: "text",
        required: false,
        placeholder: "% / $ / users",
      },
    ],
    submitLabel: "Create OKR",
    analyticsEvent: "assistant.form_create_okr_submitted",
  };
}

/** Build a CRM record form. The fields vary per objectType because
 *  Salesforce / HubSpot require different "minimum viable" fields to
 *  accept a write — Opportunity needs StageName + CloseDate, Contact
 *  needs LastName, etc. Without this form, the brittle regex-confirm
 *  flow would attempt the write with whatever it parsed and get a
 *  400 from the vendor (the 2026-05-16 "$10k deal with Jesus Christ"
 *  bug — StageName + CloseDate were missing). */
export function crmRecordFormSpec(prefill: FormPrefill = {}): FormSpec {
  const objectType = prefill.crmObjectType ?? "deal";
  /* Today's date, for the CloseDate default. Power users still get to
     override; the goal is "the write succeeds out of the box." */
  const today = new Date().toISOString().slice(0, 10);

  if (objectType === "deal") {
    return {
      formKind: "create_crm_record",
      title: "Create deal (Salesforce / HubSpot Opportunity)",
      description: "Create a CRM opportunity. Stage and Close date have safe defaults.",
      fields: [
        {
          name: "objectType",
          label: "Object type",
          type: "select",
          required: true,
          defaultValue: "deal",
          options: [
            { value: "deal", label: "Deal / Opportunity" },
            { value: "contact", label: "Contact" },
            { value: "account", label: "Account / Company" },
            { value: "task", label: "Task" },
          ],
        },
        withDefault(
          {
            name: "name",
            label: "Deal name *",
            type: "text",
            required: true,
            maxLength: 200,
            placeholder: "Acme: Q3 renewal",
          },
          prefill.crmName,
        ),
        withDefault(
          {
            name: "amount",
            label: "Amount ($) *",
            type: "text",
            required: true,
            placeholder: "10000",
            helpText: "Numeric only. Currency is the workspace default.",
          },
          prefill.crmAmount,
        ),
        {
          name: "stage",
          label: "Stage *",
          type: "select",
          required: true,
          defaultValue: "Prospecting",
          options: [
            { value: "Prospecting", label: "Prospecting" },
            { value: "Qualification", label: "Qualification" },
            { value: "Needs Analysis", label: "Needs Analysis" },
            { value: "Proposal", label: "Proposal" },
            { value: "Negotiation", label: "Negotiation" },
            { value: "Closed Won", label: "Closed Won" },
            { value: "Closed Lost", label: "Closed Lost" },
          ],
          helpText: "Required by Salesforce. Defaults to Prospecting.",
        },
        {
          name: "closeDate",
          label: "Close date *",
          type: "date",
          required: true,
          defaultValue: today,
          helpText: "Required by Salesforce. Override if known.",
        },
        {
          name: "accountName",
          label: "Account / Company",
          type: "text",
          required: false,
          placeholder: "Acme Industries (optional)",
        },
      ],
      submitLabel: "Create deal",
      analyticsEvent: "assistant.form_create_crm_record_submitted",
    };
  }

  if (objectType === "contact") {
    return {
      formKind: "create_crm_record",
      title: "Create contact",
      description: "Create a CRM contact.",
      fields: [
        {
          name: "objectType",
          label: "Object type",
          type: "select",
          required: true,
          defaultValue: "contact",
          options: [
            { value: "deal", label: "Deal / Opportunity" },
            { value: "contact", label: "Contact" },
            { value: "account", label: "Account / Company" },
            { value: "task", label: "Task" },
          ],
        },
        {
          name: "firstName",
          label: "First name",
          type: "text",
          required: false,
          placeholder: "Jane",
        },
        withDefault(
          {
            name: "lastName",
            label: "Last name *",
            type: "text",
            required: true,
            placeholder: "Doe",
          },
          prefill.crmName,
        ),
        withDefault(
          {
            name: "email",
            label: "Email",
            type: "email",
            required: false,
            placeholder: "jane@example.com",
          },
          prefill.crmEmail,
        ),
        {
          name: "accountName",
          label: "Account / Company",
          type: "text",
          required: false,
          placeholder: "Acme Industries (optional)",
        },
      ],
      submitLabel: "Create contact",
      analyticsEvent: "assistant.form_create_crm_record_submitted",
    };
  }

  if (objectType === "account") {
    return {
      formKind: "create_crm_record",
      title: "Create account / company",
      description: "Create a CRM account.",
      fields: [
        {
          name: "objectType",
          label: "Object type",
          type: "select",
          required: true,
          defaultValue: "account",
          options: [
            { value: "deal", label: "Deal / Opportunity" },
            { value: "contact", label: "Contact" },
            { value: "account", label: "Account / Company" },
            { value: "task", label: "Task" },
          ],
        },
        withDefault(
          {
            name: "name",
            label: "Account name *",
            type: "text",
            required: true,
            placeholder: "Acme Industries",
          },
          prefill.crmName,
        ),
        {
          name: "industry",
          label: "Industry",
          type: "text",
          required: false,
          placeholder: "Manufacturing / SaaS / …",
        },
        {
          name: "website",
          label: "Website",
          type: "text",
          required: false,
          placeholder: "https://...",
        },
      ],
      submitLabel: "Create account",
      analyticsEvent: "assistant.form_create_crm_record_submitted",
    };
  }

  /* Task (CRM activity, e.g. Salesforce Task — not MS To-Do).
     Distinguished from create_task in the form-kind dispatch by the
     CRM submit code path. */
  return {
    formKind: "create_crm_record",
    title: "Create CRM task",
    description: "Log a CRM activity (call, follow-up, note).",
    fields: [
      {
        name: "objectType",
        label: "Object type",
        type: "select",
        required: true,
        defaultValue: "task",
        options: [
          { value: "deal", label: "Deal / Opportunity" },
          { value: "contact", label: "Contact" },
          { value: "account", label: "Account / Company" },
          { value: "task", label: "Task" },
        ],
      },
      withDefault(
        {
          name: "subject",
          label: "Subject *",
          type: "text",
          required: true,
          placeholder: "Follow up with Jorge about pricing",
        },
        prefill.crmName,
      ),
      {
        name: "dueDate",
        label: "Due date",
        type: "date",
        required: false,
        defaultValue: today,
      },
      {
        name: "type",
        label: "Type",
        type: "select",
        required: false,
        defaultValue: "Call",
        options: [
          { value: "Call", label: "Call" },
          { value: "Email", label: "Email" },
          { value: "Meeting", label: "Meeting" },
          { value: "Other", label: "Other" },
        ],
      },
    ],
    submitLabel: "Create task",
    analyticsEvent: "assistant.form_create_crm_record_submitted",
  };
}

export function featureFormSpec(prefill: FormPrefill = {}): FormSpec {
  return {
    formKind: "create_feature",
    title: "Request a feature",
    description: "Submit a new product feature request.",
    fields: [
      withDefault(
        {
          name: "title",
          label: "Title *",
          type: "text",
          required: true,
          maxLength: 200,
          placeholder: "One-line summary",
        },
        prefill.title,
      ),
      {
        name: "description",
        label: "Description *",
        type: "textarea",
        required: true,
        placeholder: "What problem does this solve? Who is it for?",
      },
      {
        name: "target_product",
        label: "Target product",
        type: "select",
        required: false,
        defaultValue: "instinct",
        options: [
          { value: "instinct", label: "Wolfpack Instinct" },
          { value: "auto", label: "Wolfpack Auto (dealer)" },
          { value: "weekend", label: "Wolfpack Weekend" },
          { value: "agenticqa", label: "AgenticQA" },
          { value: "other", label: "Other / internal" },
        ],
      },
      {
        name: "priority",
        label: "Priority",
        type: "select",
        required: false,
        defaultValue: "normal",
        options: [
          { value: "low", label: "Low" },
          { value: "normal", label: "Normal" },
          { value: "high", label: "High" },
          { value: "critical", label: "Critical" },
        ],
      },
      {
        name: "category",
        label: "Category",
        type: "text",
        required: false,
        placeholder: "Optional tag (e.g. UX, perf, integrations)",
      },
    ],
    submitLabel: "Submit feature request",
    analyticsEvent: "assistant.form_create_feature_submitted",
  };
}

export function calendarEventFormSpec(prefill: FormPrefill = {}): FormSpec {
  return {
    formKind: "create_calendar_event",
    title: "Create calendar event",
    description: "Attendees are optional, comma-separated.",
    fields: [
      withDefault(
        {
          name: "subject",
          label: "Title *",
          type: "text",
          required: true,
          maxLength: 200,
          placeholder: "Event title",
        },
        prefill.title ?? prefill.subject,
      ),
      withDefault(
        {
          name: "start",
          label: "Start *",
          type: "datetime-local",
          required: true,
          helpText: "Local time. The Assistant converts to your timezone.",
        },
        prefill.startAt,
      ),
      withDefault(
        {
          name: "end",
          label: "End *",
          type: "datetime-local",
          required: true,
        },
        prefill.endAt,
      ),
      {
        name: "attendees",
        label: "Attendees",
        type: "text",
        required: false,
        placeholder: "alice@…, bob@… (optional)",
      },
      {
        name: "body",
        label: "Notes",
        type: "textarea",
        required: false,
        placeholder: "Optional agenda / context",
      },
    ],
    submitLabel: "Create event",
    analyticsEvent: "assistant.form_create_calendar_event_submitted",
  };
}

export function taskFormSpec(prefill: FormPrefill = {}): FormSpec {
  return {
    formKind: "create_task",
    title: "Create task",
    description: "Due date and priority are optional.",
    fields: [
      withDefault(
        {
          name: "title",
          label: "Title *",
          type: "text",
          required: true,
          maxLength: 200,
          placeholder: "What needs doing?",
        },
        prefill.title,
      ),
      {
        name: "body",
        label: "Details",
        type: "textarea",
        required: false,
        placeholder: "Optional notes",
      },
      withDefault(
        {
          name: "dueAt",
          label: "Due date",
          type: "date",
          required: false,
        },
        prefill.dueAt,
      ),
      {
        name: "importance",
        label: "Priority",
        type: "select",
        required: false,
        defaultValue: "normal",
        options: [
          { value: "low", label: "Low" },
          { value: "normal", label: "Normal" },
          { value: "high", label: "High" },
        ],
      },
    ],
    submitLabel: "Create task",
    analyticsEvent: "assistant.form_create_task_submitted",
  };
}
