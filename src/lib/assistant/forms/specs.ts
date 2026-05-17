/**
 * FormSpec builders — pure functions that return the field schema for
 * each action form. Centralized here so the test suite, the tool
 * intent matchers, and the submit endpoint share one source of truth
 * (a field added here automatically appears in the tool result, the
 * UI, AND the submit-endpoint validator).
 */

import type { FormSpec, FormField, FormFieldType } from "./types";
import type { DescribedField } from "@/lib/integrations/describe-crm";

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

export interface TaskListOption {
  value: string; // ms_list_id
  label: string; // display name
}

export function taskFormSpec(
  prefill: FormPrefill = {},
  listOptions: TaskListOption[] = [],
): FormSpec {
  const listField =
    listOptions.length > 0
      ? {
          name: "listId",
          label: "List *",
          type: "select" as const,
          required: true,
          defaultValue: listOptions[0].value,
          options: listOptions,
        }
      : {
          /* No writable lists found (user not connected to MS To-Do or
           * sync hasn't run yet). Surface a text input so the form still
           * renders, with helpful guidance text. The submit handler
           * will reject + display the failure inline. */
          name: "listId",
          label: "List *",
          type: "text" as const,
          required: true,
          placeholder: "Connect Microsoft To-Do in Settings",
          helpText:
            "We couldn't find your To-Do lists. Sync from the Tasks page, then try again.",
        };

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
      listField,
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

/* -------------------------------------------------------------------
 * Describe-driven CRM form. Replaces the hand-curated field set with
 * whatever the vendor's describe endpoint actually surfaced — so the
 * tenant's custom fields appear automatically and a Salesforce push
 * that adds a new required field doesn't 400 our submit until we
 * redeploy.
 *
 * Field-type coverage today (sufficient for the standard objects):
 *   string / number / date / datetime / select / boolean → text or
 *   typed input. reference / other → text input with the vendor's
 *   raw type as a helper string.
 * ------------------------------------------------------------------- */

function describedTypeToFormType(t: DescribedField["type"]): FormFieldType {
  switch (t) {
    case "select":
      return "select";
    case "date":
      return "date";
    case "datetime":
      return "datetime-local";
    case "number":
    case "string":
    case "boolean":
    case "reference":
    case "other":
    default:
      return "text";
  }
}

/**
 * Cap the field count so a Salesforce describe with 80+ standard +
 * custom fields doesn't render a wall of inputs. Required fields
 * always render; optional fields render up to this cap (sorted by
 * label for stability). The form's "More fields" disclosure (v2)
 * surfaces the rest.
 */
const OPTIONAL_FIELD_CAP = 6;

export function crmRecordFormSpecFromDescribe(args: {
  objectType: "deal" | "contact" | "account" | "task";
  vendor: "salesforce" | "hubspot";
  fields: DescribedField[];
  source: "live" | "fallback" | "none";
  prefill?: FormPrefill;
}): FormSpec {
  const required = args.fields.filter((f) => f.required);
  const optional = args.fields
    .filter((f) => !f.required)
    .sort((a, b) => (a.label ?? a.name).localeCompare(b.label ?? b.name))
    .slice(0, OPTIONAL_FIELD_CAP);
  const selected = [...required, ...optional];

  const formFields: FormField[] = selected.map((f) => {
    const labelBase = f.label ?? f.name;
    const label = f.required ? `${labelBase} *` : labelBase;
    const base: FormField = {
      name: f.name,
      label,
      type: describedTypeToFormType(f.type),
      required: f.required,
    };
    if (f.maxLength) base.maxLength = f.maxLength;
    if (f.type === "select" && f.options && f.options.length > 0) {
      base.options = f.options;
    }
    if (f.type === "reference" || f.type === "other") {
      base.helpText = `Vendor type: ${f.type}`;
    }
    /* Light prefill — only the obvious pairs from the user phrasing. */
    if (args.prefill) {
      if (
        (f.name === "Name" || f.name === "name" || f.name === "dealname") &&
        args.prefill.crmName
      ) {
        base.defaultValue = args.prefill.crmName;
      }
      if ((f.name === "Amount" || f.name === "amount") && args.prefill.crmAmount) {
        base.defaultValue = args.prefill.crmAmount;
      }
      if ((f.name === "Email" || f.name === "email") && args.prefill.crmEmail) {
        base.defaultValue = args.prefill.crmEmail;
      }
    }
    return base;
  });

  const sourceNote =
    args.source === "live"
      ? `Fields mirror your ${args.vendor === "salesforce" ? "Salesforce" : "HubSpot"} schema.`
      : args.source === "fallback"
      ? "Showing a cached field set — vendor describe was unavailable. Submit may need updates after the next sync."
      : "No schema available; submit at your own risk.";

  return {
    formKind: "create_crm_record",
    title: `Create ${args.objectType}`,
    description: sourceNote,
    fields: formFields,
    submitLabel: `Create ${args.objectType}`,
    analyticsEvent: "assistant.form_create_crm_record_submitted",
  };
}
