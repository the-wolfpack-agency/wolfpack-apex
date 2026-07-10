import {
  validateTaskTemplate,
  composeGuidance,
  TASK_TEMPLATE_FIELDS,
  TEMPLATE_LIMITS,
} from "@/lib/agents/tasks/template";

describe("task template validation", () => {
  it("accepts a complete template and trims fields", () => {
    const r = validateTaskTemplate({
      objective: "  Reconcile June invoices  ",
      successCriteria: "  All 31 matched or flagged  ",
      context: "  SharePoint /Finance  ",
      targetConnectionId: "conn-1",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.objective).toBe("Reconcile June invoices");
      expect(r.value.successCriteria).toBe("All 31 matched or flagged");
      expect(r.value.context).toBe("SharePoint /Finance");
      expect(r.value.targetConnectionId).toBe("conn-1");
    }
  });

  it("requires objective", () => {
    const r = validateTaskTemplate({ objective: "   ", successCriteria: "done" });
    expect(r).toEqual({ ok: false, error: "Objective is required." });
  });

  it("requires success criteria", () => {
    const r = validateTaskTemplate({ objective: "do it", successCriteria: "" });
    expect(r).toEqual({ ok: false, error: "Success criteria is required." });
  });

  it("omits optional fields when blank", () => {
    const r = validateTaskTemplate({ objective: "do it", successCriteria: "done" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.context).toBeUndefined();
      expect(r.value.targetConnectionId).toBeUndefined();
    }
  });

  it("enforces the objective length cap", () => {
    const r = validateTaskTemplate({
      objective: "x".repeat(TEMPLATE_LIMITS.objective + 1),
      successCriteria: "done",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Objective must be <=/);
  });

  it("enforces the success-criteria length cap", () => {
    const r = validateTaskTemplate({
      objective: "do it",
      successCriteria: "x".repeat(TEMPLATE_LIMITS.successCriteria + 1),
    });
    expect(r.ok).toBe(false);
  });
});

describe("composeGuidance", () => {
  it("always includes the success criteria and omits blank optionals", () => {
    const g = composeGuidance({ objective: "o", successCriteria: "done well" });
    expect(g).toBe("Success criteria (the definition of done): done well");
  });

  it("includes context and target when present", () => {
    const g = composeGuidance({
      objective: "o",
      successCriteria: "done",
      context: "bg",
      targetConnectionId: "salesforce",
    });
    expect(g).toContain("Success criteria (the definition of done): done");
    expect(g).toContain("Context: bg");
    expect(g).toContain("Target system: salesforce");
  });
});

describe("TASK_TEMPLATE_FIELDS", () => {
  it("marks objective and success criteria as the required fields", () => {
    const required = TASK_TEMPLATE_FIELDS.filter((f) => f.required).map((f) => f.key);
    expect(required).toEqual(["objective", "successCriteria"]);
  });
});
