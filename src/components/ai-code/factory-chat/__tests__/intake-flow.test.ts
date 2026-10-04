/**
 * Guided intake flow: the codified expertise. composeRequest turns a non-expert's
 * plain answers into a precise, SDLC-complete request; isComplete gates on the
 * required steps; every goal composes without throwing.
 */
import { INTAKE_GOALS, goalById, isComplete, composeRequest } from "@/components/ai-code/factory-chat/intake-flow";

describe("flow integrity", () => {
  it("every goal has a unique id, a task type, and at least one required step", () => {
    const ids = new Set<string>();
    for (const g of INTAKE_GOALS) {
      expect(ids.has(g.id)).toBe(false); ids.add(g.id);
      expect(g.taskType).toBeTruthy();
      expect(g.steps.some((s) => s.required)).toBe(true);
    }
  });
});

describe("isComplete", () => {
  it("requires every required step to be answered", () => {
    const g = goalById("feature")!;
    expect(isComplete(g, {})).toBe(false);
    expect(isComplete(g, { what: "a dashboard" })).toBe(true); // only `what` is required
    expect(isComplete(g, { what: "   " })).toBe(false); // whitespace doesn't count
  });
});

describe("composeRequest", () => {
  it("feature: bakes in the auth + tests defaults the user chose", () => {
    const g = goalById("feature")!;
    const r = composeRequest(g, { what: "list invoices", where: "billing", data: "yes", auth: "yes", tests: "yes" });
    expect(r).toMatch(/Add a new feature: list invoices/);
    expect(r).toMatch(/Place it in: billing/);
    expect(r).toMatch(/persist and read data/);
    expect(r).toMatch(/Require authentication/);
    expect(r).toMatch(/Include tests/);
  });
  it("feature: honors 'no auth' + 'no tests'", () => {
    const r = composeRequest(goalById("feature")!, { what: "a public status page", auth: "no", tests: "no" });
    expect(r).toMatch(/can be public/);
    expect(r).toMatch(/Tests are optional/);
  });
  it("fix: asks for a regression test by default", () => {
    const r = composeRequest(goalById("fix")!, { symptom: "save button does nothing", tests: "yes" });
    expect(r).toMatch(/Investigate and fix a bug: save button does nothing/);
    expect(r).toMatch(/regression test/);
  });
  it("improve: preserves behavior + forbids duplication by default", () => {
    const r = composeRequest(goalById("improve")!, { what: "the checkout code", behavior: "yes" });
    expect(r).toMatch(/Preserve the existing behavior/);
    expect(r).toMatch(/Do not duplicate/);
  });
  it("every goal composes a non-empty request from its required answers", () => {
    for (const g of INTAKE_GOALS) {
      const answers = Object.fromEntries(g.steps.filter((s) => s.required).map((s) => [s.id, "x"]));
      expect(composeRequest(g, answers).length).toBeGreaterThan(0);
    }
  });
});
