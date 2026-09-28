/**
 * The mechanical-vs-governance classifier decides whether a CI failure is safe
 * to auto-repair (mechanical) or must go to a human (governance/policy gate).
 * Getting this wrong in the "governance -> mechanical" direction is the dangerous
 * case (an autofixer editing code to make a guardrail pass), so the tests pin the
 * governance signals hard.
 */
import { classifyCiFailure } from "@/lib/ai-code/ci-failure-classify";

describe("governance failures escalate (never auto-fixed)", () => {
  it("classifies a guardrail-test detail as governance", () => {
    const c = classifyCiFailure("Route src/app/api/x/route.ts has a mutation handler but neither imports recordAudit nor is listed in AUDIT_ALLOWLIST", []);
    expect(c.kind).toBe("governance");
    expect(c.signal).toMatch(/AUDIT_ALLOWLIST/);
  });

  it.each([
    ["audit-coverage failing", "audit-coverage.test.ts failed"],
    ["capability-coverage", "capability-coverage guard failed"],
    ["no-raw-api-fetch", "no-raw-api-fetch.test.ts caught a raw fetch"],
    ["tenant isolation", "tenant-isolation scan found an unscoped query"],
    ["RLS", "RLS not enforced on table x"],
  ])("detail signal: %s", (_label, detail) => {
    expect(classifyCiFailure(detail, []).kind).toBe("governance");
  });

  it.each([
    ["CodeQL", "CodeQL"],
    ["Static Security Scan", "Static Security Scan"],
    ["Pentest Validation", "Pentest Validation"],
    ["Dependency Audit", "Dependency Audit"],
  ])("failing check name: %s", (_label, check) => {
    const c = classifyCiFailure("", [check]);
    expect(c.kind).toBe("governance");
    expect(c.signal).toBe(`check:${check}`);
  });
});

describe("mechanical failures are auto-fixable", () => {
  it("a jest assertion failure is mechanical", () => {
    expect(classifyCiFailure("FAIL src/lib/__tests__/readingTime.test.ts\nExpected 5 Received NaN", ["agenticqa-full-pipeline"]).kind).toBe("mechanical");
  });
  it("a type error is mechanical", () => {
    expect(classifyCiFailure("error TS2322: Type 'string' is not assignable to 'number'", ["lint-types"]).kind).toBe("mechanical");
  });
  it("empty / unknown is mechanical (the fixer's bounded loop handles it safely)", () => {
    expect(classifyCiFailure("", []).kind).toBe("mechanical");
  });
});
