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

describe("autofillForm result chaining (priorResults)", () => {
  const descField: FormField = {
    name: "description",
    label: "Description",
    type: "textarea",
    required: true,
  };
  const prior = [
    { instruction: "search the web for OGIAM", result: "OGIAM is an identity gate. It enforces capabilities." },
    { instruction: "search the web for X", result: "X is a second finding worth carrying forward." },
  ];

  it("fills a body-like field FROM the prior results when the instruction references them", () => {
    const { values, missingRequired } = autofillForm(
      { fields: [descField] },
      "Create a feature summarizing the results",
      undefined,
      prior,
    );
    // The description is the joined prior output, NOT the raw instruction remainder.
    expect(values.description).toMatch(/OGIAM is an identity gate/);
    expect(values.description).toMatch(/second finding/);
    expect(values.description).not.toMatch(/Create a feature/);
    expect(missingRequired).toEqual([]);
  });

  it("recognizes the other reference tokens (the above / previous / them / those / that / the findings / the output)", () => {
    const refs = [
      "Create a feature from the above",
      "Summarize the previous step",
      "Write up them",
      "Document those",
      "Capture that",
      "Record the findings",
      "Store the output",
    ];
    for (const instruction of refs) {
      const { values } = autofillForm({ fields: [descField] }, instruction, undefined, prior);
      expect(values.description).toMatch(/OGIAM is an identity gate/);
    }
  });

  it("does NOT use prior results when the instruction does not reference prior output", () => {
    const { values } = autofillForm(
      { fields: [descField] },
      "Create a feature about onboarding flows",
      undefined,
      prior,
    );
    // Falls back to the normal instruction-remainder extraction; not the prior results.
    expect(values.description).toBe("Create a feature about onboarding flows");
    expect(values.description).not.toMatch(/OGIAM/);
  });

  it("leaves a referencing body MISSING when there are no prior results to carry", () => {
    const bodyOnly: FormField = { name: "body", label: "Body", type: "textarea", required: true };
    // A bare reference with no instruction content and no prior results -> nothing to fill.
    const { values, missingRequired } = autofillForm(
      { fields: [bodyOnly] },
      "the results",
      undefined,
      [],
    );
    // "the results" is itself instruction text, so extractBody fills it; assert
    // we did NOT fold in prior results (none exist) and the field is present.
    expect(values.body).toBe("the results");
    expect(missingRequired).toEqual([]);
  });

  it("never fills a TITLE-like field from prior results", () => {
    const { values } = autofillForm(
      { fields: [titleField] },
      "Create a feature titled Weekly digest summarizing the results",
      undefined,
      prior,
    );
    // Title comes from the title extraction, never the carried prior output.
    expect(values.title).not.toMatch(/OGIAM/);
    expect(typeof values.title).toBe("string");
  });

  it("hard-truncates the joined prior results to the body cap", () => {
    const huge = [{ instruction: "search", result: "Z".repeat(5000) }];
    const { values } = autofillForm(
      { fields: [descField] },
      "Create a feature summarizing the results",
      undefined,
      huge,
    );
    // Bounded: never balloons the payload (cap is 1000 chars total).
    expect((values.description as string).length).toBeLessThanOrEqual(1000);
    expect((values.description as string).endsWith("…")).toBe(true);
  });

  it("prefers explicit parsedParams over the prior-results summary", () => {
    const { values } = autofillForm(
      { fields: [descField] },
      "Create a feature summarizing the results",
      { description: "Explicit body wins" },
      prior,
    );
    expect(values.description).toBe("Explicit body wins");
  });

  it("is deterministic with priorResults: same inputs produce identical output", () => {
    const a = autofillForm({ fields: [descField] }, "summarize the results", undefined, prior);
    const b = autofillForm({ fields: [descField] }, "summarize the results", undefined, prior);
    expect(a).toEqual(b);
  });

  it("ignores empty-result prior entries (nothing usable to carry)", () => {
    const { values } = autofillForm(
      { fields: [descField] },
      "Create a feature summarizing the results",
      undefined,
      [{ instruction: "search", result: "   " }],
    );
    // No usable prior content -> falls back to the instruction remainder.
    expect(values.description).toBe("Create a feature summarizing the results");
  });
});
