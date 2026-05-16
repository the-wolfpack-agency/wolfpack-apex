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
}

function withDefault(field: FormField, value: string | undefined): FormField {
  return value ? { ...field, defaultValue: value } : field;
}

export function emailFormSpec(prefill: FormPrefill = {}): FormSpec {
  return {
    formKind: "create_email",
    title: "Create email",
    description:
      "Fill in the recipient, subject, and body. Required fields are marked with *.",
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
    description:
      "Pick a Teams chat and write your message. Both fields are required.",
    fields: [
      withDefault(
        {
          name: "chatId",
          label: "Teams chat *",
          type: "text",
          required: true,
          placeholder: "Chat id (paste from /messages or search by name)",
          helpText:
            'Open /messages, click the chat, copy the id from the URL. Future versions will autocomplete chat names.',
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

export function calendarEventFormSpec(prefill: FormPrefill = {}): FormSpec {
  return {
    formKind: "create_calendar_event",
    title: "Create calendar event",
    description:
      "Title, start, and end are required. Attendees are optional and comma-separated.",
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
    description:
      "Title is required. Due date and priority are optional.",
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
