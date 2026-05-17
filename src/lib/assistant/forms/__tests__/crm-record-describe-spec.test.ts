/**
 * crmRecordFormSpecFromDescribe — turns DescribedField[] into a
 * FormSpec the chat surface can render. Field-type mapping +
 * required ordering + optional-field cap pinned here so a future
 * Salesforce custom-field push doesn't surprise us.
 */

import { crmRecordFormSpecFromDescribe } from "@/lib/assistant/forms/specs";
import type { DescribedField } from "@/lib/integrations/describe-crm";

function field(overrides: Partial<DescribedField>): DescribedField {
  return {
    name: "X",
    type: "string",
    required: false,
    ...overrides,
  };
}

describe("crmRecordFormSpecFromDescribe", () => {
  test("renders required fields first, then capped optional", () => {
    const fields: DescribedField[] = [
      field({ name: "opt_a", label: "Optional A" }),
      field({ name: "Name", required: true, label: "Name" }),
      field({ name: "opt_b", label: "Optional B" }),
      field({ name: "opt_c", label: "Optional C" }),
      field({ name: "opt_d", label: "Optional D" }),
      field({ name: "opt_e", label: "Optional E" }),
      field({ name: "opt_f", label: "Optional F" }),
      field({ name: "opt_g", label: "Optional G" }),
      field({ name: "StageName", required: true, label: "Stage" }),
    ];
    const spec = crmRecordFormSpecFromDescribe({
      objectType: "deal",
      vendor: "salesforce",
      fields,
      source: "live",
    });
    /* Required first (2), then up to 6 optional. */
    expect(spec.fields).toHaveLength(8);
    expect(spec.fields[0].name).toBe("Name");
    expect(spec.fields[1].name).toBe("StageName");
    /* Optional come in alphabetical order by label. */
    expect(spec.fields.slice(2).map((f) => f.name)).toEqual([
      "opt_a", "opt_b", "opt_c", "opt_d", "opt_e", "opt_f",
    ]);
  });

  test("type mapping: select keeps options; date → date; number → text", () => {
    const fields: DescribedField[] = [
      field({ name: "Stage", required: true, type: "select", options: [
        { value: "P", label: "Prospect" }, { value: "C", label: "Closed" },
      ] }),
      field({ name: "CloseDate", required: true, type: "date" }),
      field({ name: "Amount", type: "number" }),
      field({ name: "AccountId", type: "reference" }),
    ];
    const spec = crmRecordFormSpecFromDescribe({
      objectType: "deal", vendor: "salesforce", fields, source: "live",
    });
    expect(spec.fields.find((f) => f.name === "Stage")?.type).toBe("select");
    expect(spec.fields.find((f) => f.name === "Stage")?.options).toHaveLength(2);
    expect(spec.fields.find((f) => f.name === "CloseDate")?.type).toBe("date");
    expect(spec.fields.find((f) => f.name === "Amount")?.type).toBe("text");
    /* Reference type still text but with helper copy. */
    expect(spec.fields.find((f) => f.name === "AccountId")?.helpText).toMatch(/reference/);
  });

  test("required label suffix and pre-fill from intent extraction", () => {
    const fields: DescribedField[] = [
      field({ name: "Name", required: true, label: "Account name" }),
      field({ name: "Amount", required: true, type: "number" }),
    ];
    const spec = crmRecordFormSpecFromDescribe({
      objectType: "deal", vendor: "salesforce", fields, source: "live",
      prefill: { crmName: "Acme Renewal", crmAmount: "50000" },
    });
    const nameField = spec.fields.find((f) => f.name === "Name");
    expect(nameField?.label).toBe("Account name *");
    expect(nameField?.defaultValue).toBe("Acme Renewal");
    expect(spec.fields.find((f) => f.name === "Amount")?.defaultValue).toBe("50000");
  });

  test("description text surfaces describe source for the UI", () => {
    const live = crmRecordFormSpecFromDescribe({
      objectType: "deal", vendor: "salesforce", fields: [], source: "live",
    });
    expect(live.description).toMatch(/mirror your Salesforce/);
    const fallback = crmRecordFormSpecFromDescribe({
      objectType: "deal", vendor: "hubspot", fields: [], source: "fallback",
    });
    expect(fallback.description).toMatch(/cached field set/i);
    const none = crmRecordFormSpecFromDescribe({
      objectType: "deal", vendor: "salesforce", fields: [], source: "none",
    });
    expect(none.description).toMatch(/No schema available/i);
  });
});
