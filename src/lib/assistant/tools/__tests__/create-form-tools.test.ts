/**
 * Chat action form-trigger tools — intent + handler tests for all four
 * tools (email, message, calendar event, task). Each tool returns a
 * FormSpec the chat UI renders inline; the test asserts:
 *   1. matchIntent triggers on common phrasings, rejects ambiguous ones
 *   2. The handler returns { ok: true, form: { ... } } with the right
 *      formKind + required fields
 *   3. Pre-fill flows from the user's phrasing into form defaults
 *   4. The form-offered analytics event fires
 */

const mockTrackEvent = jest.fn();
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: any[]) => mockTrackEvent(...a),
}));

import { createEmailFormTool } from "@/lib/assistant/tools/create-email-form-tool";
import { createMessageFormTool } from "@/lib/assistant/tools/create-message-form-tool";
import { createCalendarEventFormTool } from "@/lib/assistant/tools/create-calendar-event-form-tool";
import { createTaskFormTool } from "@/lib/assistant/tools/create-task-form-tool";
import { createOkrFormTool } from "@/lib/assistant/tools/create-okr-form-tool";
import { createFeatureFormTool } from "@/lib/assistant/tools/create-feature-form-tool";
import { createCrmRecordFormTool } from "@/lib/assistant/tools/create-crm-record-form-tool";

const ctx = { userId: "u1", userRole: "cto", workspaceId: "ws1" };

beforeEach(() => mockTrackEvent.mockClear());

/* ---------------------------------------------------------------------
 * Email
 * ------------------------------------------------------------------- */

describe("create_email_form — intent", () => {
  test.each([
    "create email",
    "create an email",
    "compose email",
    "draft an email",
    "send an email",
    "write an email",
    "new email",
  ])("'%s' matches", (msg) => {
    expect(createEmailFormTool.matchIntent(msg)).not.toBeNull();
  });

  test.each([
    "find emails from Max",
    "what's my email signature",
    "look up Acme",
    "create task",
  ])("'%s' does NOT match", (msg) => {
    expect(createEmailFormTool.matchIntent(msg)).toBeNull();
  });

  test("'create email to alice@example.com about Q3' pre-fills to + subject", () => {
    const p = createEmailFormTool.matchIntent("create email to alice@example.com about Q3 plan");
    expect(p?.to).toBe("alice@example.com");
    expect(p?.subject).toContain("Q3 plan");
  });
});

describe("create_email_form — handler", () => {
  test("returns FormSpec with email-shaped fields + required to/subject/body", async () => {
    const r = await createEmailFormTool.handler({}, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.form?.formKind).toBe("create_email");
    const names = r.form?.fields.map((f) => f.name);
    expect(names).toEqual(expect.arrayContaining(["to", "subject", "body"]));
    const to = r.form?.fields.find((f) => f.name === "to");
    expect(to?.required).toBe(true);
    expect(to?.type).toBe("email");
  });

  test("pre-fills to field when intent captured it", async () => {
    const r = await createEmailFormTool.handler({ to: "alice@example.com" }, ctx);
    if (!r.ok) throw new Error("expected ok");
    const to = r.form?.fields.find((f) => f.name === "to");
    expect(to?.defaultValue).toBe("alice@example.com");
  });

  test("fires form_offered analytics", async () => {
    await createEmailFormTool.handler({ to: "x@y.com" }, ctx);
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "assistant.form_offered",
      "u1", "cto",
      expect.objectContaining({ form_kind: "create_email", prefilled_to: true }),
    );
  });
});

/* ---------------------------------------------------------------------
 * Message
 * ------------------------------------------------------------------- */

describe("create_message_form — intent", () => {
  test.each([
    "create message",
    "send a teams message",
    "compose a message",
    "draft a teams message",
    "new message",
  ])("'%s' matches", (msg) => {
    expect(createMessageFormTool.matchIntent(msg)).not.toBeNull();
  });

  test.each([
    "find emails from Max",
    "send a message about Q3", // "about" excluded — would conflict
    "create email",
    "send a message labeled urgent",
  ])("'%s' does NOT match (too ambiguous or other tool's job)", (msg) => {
    expect(createMessageFormTool.matchIntent(msg)).toBeNull();
  });
});

describe("create_message_form — handler", () => {
  test("returns form with recipient + body required (username resolves server-side to chat id)", async () => {
    const r = await createMessageFormTool.handler({}, ctx);
    if (!r.ok) throw new Error("expected ok");
    expect(r.form?.formKind).toBe("create_message");
    const fields = r.form?.fields ?? [];
    expect(fields.find((f) => f.name === "recipient")?.required).toBe(true);
    expect(fields.find((f) => f.name === "body")?.required).toBe(true);
  });
});

/* ---------------------------------------------------------------------
 * Calendar event
 * ------------------------------------------------------------------- */

describe("create_calendar_event_form — intent", () => {
  test.each([
    "create calendar event",
    "create event",
    "schedule a meeting",
    "book a meeting",
    "new calendar event",
    "set up a call",
  ])("'%s' matches", (msg) => {
    expect(createCalendarEventFormTool.matchIntent(msg)).not.toBeNull();
  });

  test.each([
    "any meetings tomorrow",
    "what meetings do I have today",
    "create email",
  ])("'%s' does NOT match", (msg) => {
    expect(createCalendarEventFormTool.matchIntent(msg)).toBeNull();
  });

  test("'schedule a meeting titled Q3 review' pre-fills title", () => {
    const p = createCalendarEventFormTool.matchIntent("schedule a meeting titled Q3 review");
    expect(p?.title).toBe("Q3 review");
  });
});

describe("create_calendar_event_form — handler", () => {
  test("returns form with subject/start/end required", async () => {
    const r = await createCalendarEventFormTool.handler({}, ctx);
    if (!r.ok) throw new Error("expected ok");
    expect(r.form?.formKind).toBe("create_calendar_event");
    const fields = r.form?.fields ?? [];
    expect(fields.find((f) => f.name === "subject")?.required).toBe(true);
    expect(fields.find((f) => f.name === "start")?.required).toBe(true);
    expect(fields.find((f) => f.name === "end")?.required).toBe(true);
    expect(fields.find((f) => f.name === "attendees")?.required).toBe(false);
  });

  test("start + end are datetime-local fields", async () => {
    const r = await createCalendarEventFormTool.handler({}, ctx);
    if (!r.ok) throw new Error("expected ok");
    const start = r.form?.fields.find((f) => f.name === "start");
    expect(start?.type).toBe("datetime-local");
  });
});

/* ---------------------------------------------------------------------
 * Task
 * ------------------------------------------------------------------- */

describe("create_task_form — intent", () => {
  test.each([
    "create task",
    "add a task",
    "new task",
    "create a todo",
  ])("'%s' matches", (msg) => {
    expect(createTaskFormTool.matchIntent(msg)).not.toBeNull();
  });

  test("'create a task to follow up Friday' does NOT match (CRM action tool's job)", () => {
    expect(createTaskFormTool.matchIntent("create a task to follow up Friday")).toBeNull();
  });

  test("'create task titled Ship Q3' pre-fills title", () => {
    const p = createTaskFormTool.matchIntent("create task titled Ship Q3");
    expect(p?.title).toBe("Ship Q3");
  });
});

describe("create_task_form — handler", () => {
  test("returns form with title required only; due + importance optional", async () => {
    const r = await createTaskFormTool.handler({}, ctx);
    if (!r.ok) throw new Error("expected ok");
    expect(r.form?.formKind).toBe("create_task");
    const fields = r.form?.fields ?? [];
    expect(fields.find((f) => f.name === "title")?.required).toBe(true);
    expect(fields.find((f) => f.name === "dueAt")?.required).toBe(false);
    expect(fields.find((f) => f.name === "importance")?.type).toBe("select");
  });

  test("includes a required listId field (Graph rejects literal 'default')", async () => {
    const r = await createTaskFormTool.handler({}, ctx);
    if (!r.ok) throw new Error("expected ok");
    const listField = r.form?.fields.find((f) => f.name === "listId");
    expect(listField).toBeDefined();
    expect(listField?.required).toBe(true);
  });
});

/* ---------------------------------------------------------------------
 * OKR
 * ------------------------------------------------------------------- */

describe("create_okr_form — intent", () => {
  test.each([
    "create OKR",
    "new OKR",
    "add OKR",
    "create objective",
    "draft OKR",
  ])("'%s' matches", (msg) => {
    expect(createOkrFormTool.matchIntent(msg)).not.toBeNull();
  });

  test.each([
    "what are our OKRs",
    "show me OKRs",
  ])("'%s' does NOT match (lookup, not create)", (msg) => {
    expect(createOkrFormTool.matchIntent(msg)).toBeNull();
  });
});

describe("create_okr_form — handler", () => {
  test("returns form with quarter, objective, kr_metric, kr_target required", async () => {
    const r = await createOkrFormTool.handler({}, ctx);
    if (!r.ok) throw new Error("expected ok");
    expect(r.form?.formKind).toBe("create_okr");
    const fields = r.form?.fields ?? [];
    expect(fields.find((f) => f.name === "quarter")?.required).toBe(true);
    expect(fields.find((f) => f.name === "objective")?.required).toBe(true);
    expect(fields.find((f) => f.name === "kr_metric")?.required).toBe(true);
    expect(fields.find((f) => f.name === "kr_target")?.required).toBe(true);
    expect(fields.find((f) => f.name === "kr_unit")?.required).toBe(false);
    /* Quarter pre-filled with current YYYY-Qn so a quick submit works. */
    expect(fields.find((f) => f.name === "quarter")?.defaultValue).toMatch(/^\d{4}-Q[1-4]$/);
  });
});

/* ---------------------------------------------------------------------
 * Feature
 * ------------------------------------------------------------------- */

describe("create_feature_form — intent", () => {
  test.each([
    "create feature",
    "new feature request",
    "request a feature",
    "file a feature",
    "add a roadmap item",
  ])("'%s' matches", (msg) => {
    expect(createFeatureFormTool.matchIntent(msg)).not.toBeNull();
  });

  test("'create email' does NOT match (email tool's job)", () => {
    expect(createFeatureFormTool.matchIntent("create email")).toBeNull();
  });
});

describe("create_feature_form — handler", () => {
  test("returns form with title + description required, target_product/priority as selects", async () => {
    const r = await createFeatureFormTool.handler({}, ctx);
    if (!r.ok) throw new Error("expected ok");
    expect(r.form?.formKind).toBe("create_feature");
    const fields = r.form?.fields ?? [];
    expect(fields.find((f) => f.name === "title")?.required).toBe(true);
    expect(fields.find((f) => f.name === "description")?.required).toBe(true);
    expect(fields.find((f) => f.name === "target_product")?.type).toBe("select");
    expect(fields.find((f) => f.name === "priority")?.type).toBe("select");
  });
});

/* ---------------------------------------------------------------------
 * CRM record (replaces the brittle regex-confirm path)
 * ------------------------------------------------------------------- */

describe("create_crm_record_form — intent", () => {
  test("'create a $10k deal with Jesus Christ' captures objectType=deal + amount + name", () => {
    const p = createCrmRecordFormTool.matchIntent("create a $10k deal with Jesus Christ");
    expect(p?.objectType).toBe("deal");
    expect(p?.amount).toBe("10000");
    expect(p?.name).toBe("Jesus Christ");
  });

  test("'create a deal for Acme' captures account name", () => {
    const p = createCrmRecordFormTool.matchIntent("create a deal for Acme Industries");
    expect(p?.objectType).toBe("deal");
    expect(p?.name).toBe("Acme Industries");
  });

  test("'add new opportunity' → objectType=deal (opportunity aliases to deal)", () => {
    const p = createCrmRecordFormTool.matchIntent("add new opportunity");
    expect(p?.objectType).toBe("deal");
  });

  test("'create contact jane@example.com' captures email", () => {
    const p = createCrmRecordFormTool.matchIntent("create contact jane@example.com");
    expect(p?.objectType).toBe("contact");
    expect(p?.email).toBe("jane@example.com");
  });

  test("'create account Acme' captures name", () => {
    const p = createCrmRecordFormTool.matchIntent("create account named Acme Industries");
    expect(p?.objectType).toBe("account");
    expect(p?.name).toBe("Acme Industries");
  });

  test.each([
    "create task",                // bare → MS To-Do form tool
    "create email",
    "create message",
    "create calendar event",
  ])("'%s' does NOT match (other tools own these)", (msg) => {
    expect(createCrmRecordFormTool.matchIntent(msg)).toBeNull();
  });

  test("'create CRM task' explicitly matches (vs bare 'create task')", () => {
    const p = createCrmRecordFormTool.matchIntent("create CRM task");
    expect(p?.objectType).toBe("task");
  });
});

describe("create_crm_record_form — handler renders the right form per object type", () => {
  test("deal form includes Stage + CloseDate as required (the regex-confirm bug fix)", async () => {
    const r = await createCrmRecordFormTool.handler({ objectType: "deal" }, ctx);
    if (!r.ok) throw new Error("expected ok");
    expect(r.form?.formKind).toBe("create_crm_record");
    const fields = r.form?.fields ?? [];
    expect(fields.find((f) => f.name === "stage")?.required).toBe(true);
    expect(fields.find((f) => f.name === "closeDate")?.required).toBe(true);
    expect(fields.find((f) => f.name === "amount")?.required).toBe(true);
    expect(fields.find((f) => f.name === "name")?.required).toBe(true);
    /* Stage defaults to Prospecting + closeDate defaults to today so a
       fast submit succeeds without manual input. */
    expect(fields.find((f) => f.name === "stage")?.defaultValue).toBe("Prospecting");
    expect(fields.find((f) => f.name === "closeDate")?.defaultValue).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test("contact form requires only LastName", async () => {
    const r = await createCrmRecordFormTool.handler({ objectType: "contact" }, ctx);
    if (!r.ok) throw new Error("expected ok");
    const fields = r.form?.fields ?? [];
    expect(fields.find((f) => f.name === "lastName")?.required).toBe(true);
    expect(fields.find((f) => f.name === "firstName")?.required).toBe(false);
    expect(fields.find((f) => f.name === "email")?.required).toBe(false);
  });

  test("account form requires only Name", async () => {
    const r = await createCrmRecordFormTool.handler({ objectType: "account" }, ctx);
    if (!r.ok) throw new Error("expected ok");
    const fields = r.form?.fields ?? [];
    expect(fields.find((f) => f.name === "name")?.required).toBe(true);
  });

  test("pre-fills name + amount + email from intent extraction", async () => {
    const r = await createCrmRecordFormTool.handler(
      { objectType: "deal", name: "Acme Renewal", amount: "50000", email: "x@y.co" },
      ctx,
    );
    if (!r.ok) throw new Error("expected ok");
    const fields = r.form?.fields ?? [];
    expect(fields.find((f) => f.name === "name")?.defaultValue).toBe("Acme Renewal");
    expect(fields.find((f) => f.name === "amount")?.defaultValue).toBe("50000");
  });
});
