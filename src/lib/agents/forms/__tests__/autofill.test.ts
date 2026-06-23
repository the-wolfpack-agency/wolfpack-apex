/**
 * autofillForm: generic, deterministic agent form fill. These tests pin the
 * priority order (parsedParams > instruction extraction > defaultValue), the
 * common-name extraction rules (title-like / body-like), and the
 * missingRequired contract the executor relies on to escalate to the owner.
 */

import { autofillForm } from "@/lib/agents/forms/autofill";
import type { FormField } from "@/lib/assistant/forms/types";

const titleField: FormField = { name: "title", label: "Title", type: "text", required: true };
const listField: FormField = {
  name: "listId",
  label: "List",
  type: "select",
  required: true,
  defaultValue: "LIST-DEFAULT",
};
const bodyField: FormField = { name: "body", label: "Details", type: "textarea", required: false };
const importanceField: FormField = {
  name: "importance",
  label: "Priority",
  type: "select",
  required: false,
  defaultValue: "normal",
};

describe("autofillForm", () => {
  it("fills a title from a 'titled X' clause in the instruction", () => {
    const { values, missingRequired } = autofillForm(
      { fields: [titleField] },
      'add a task titled "Demo"',
    );
    expect(values.title).toBe("Demo");
    expect(missingRequired).toEqual([]);
  });

  it("fills a title from the trailing clause when there is no explicit keyword", () => {
    const { values } = autofillForm({ fields: [titleField] }, "add a task Buy milk");
    expect(values.title).toBe("Buy milk");
  });

  it("recognizes called / named / about as title keywords", () => {
    expect(autofillForm({ fields: [titleField] }, "create a task called Foo").values.title).toBe("Foo");
    expect(autofillForm({ fields: [titleField] }, "new task named Bar").values.title).toBe("Bar");
    expect(autofillForm({ fields: [titleField] }, "add a task about Baz").values.title).toBe("Baz");
  });

  it("prefers parsedParams over instruction extraction", () => {
    const { values } = autofillForm(
      { fields: [titleField] },
      "add a task titled Wrong",
      { title: "Right" },
    );
    expect(values.title).toBe("Right");
  });

  it("uses the FormSpec defaultValue when nothing else fills the field", () => {
    const { values, missingRequired } = autofillForm(
      { fields: [titleField, listField] },
      "add a task titled Demo",
    );
    expect(values.listId).toBe("LIST-DEFAULT"); // from defaultValue
    expect(values.title).toBe("Demo");
    expect(missingRequired).toEqual([]);
  });

  it("fills body-like fields with the instruction remainder", () => {
    const { values } = autofillForm({ fields: [bodyField] }, "add a task titled Demo about pricing");
    expect(typeof values.body).toBe("string");
    expect(values.body).toMatch(/Demo/);
  });

  it("maps description / notes / details to the body extraction too", () => {
    const desc: FormField = { name: "description", label: "Desc", type: "textarea", required: false };
    const notes: FormField = { name: "notes", label: "Notes", type: "textarea", required: false };
    const details: FormField = { name: "details", label: "Det", type: "textarea", required: false };
    const out = autofillForm({ fields: [desc, notes, details] }, "do the thing");
    expect(out.values.description).toBe("do the thing");
    expect(out.values.notes).toBe("do the thing");
    expect(out.values.details).toBe("do the thing");
  });

  it("reports a required field it cannot fill in missingRequired", () => {
    const noDefaultList: FormField = { name: "listId", label: "List", type: "text", required: true };
    const { values, missingRequired } = autofillForm(
      { fields: [titleField, noDefaultList] },
      "add a task", // no title clause, no list default
    );
    // "add a task" yields no usable trailing title and no default, so both are missing.
    expect(missingRequired).toContain("listId");
    expect(values.listId).toBeUndefined();
  });

  it("does NOT mark optional unfilled fields as missing", () => {
    const { missingRequired } = autofillForm({ fields: [bodyField] }, "x");
    expect(missingRequired).toEqual([]);
  });

  it("keeps optional defaulted fields (importance=normal) and never lists them missing", () => {
    const { values, missingRequired } = autofillForm(
      { fields: [titleField, listField, importanceField] },
      "add a task titled Demo",
    );
    expect(values.importance).toBe("normal");
    expect(missingRequired).toEqual([]);
  });

  it("is deterministic: same inputs produce identical output", () => {
    const a = autofillForm({ fields: [titleField, listField] }, "add a task titled Demo");
    const b = autofillForm({ fields: [titleField, listField] }, "add a task titled Demo");
    expect(a).toEqual(b);
  });

  it("treats empty / whitespace parsedParams as absent and falls through", () => {
    const { values } = autofillForm(
      { fields: [titleField] },
      "add a task titled Demo",
      { title: "   " },
    );
    expect(values.title).toBe("Demo"); // fell through to instruction
  });

  it("handles a form with no fields", () => {
    expect(autofillForm({ fields: [] }, "anything")).toEqual({ values: {}, missingRequired: [] });
  });
});
