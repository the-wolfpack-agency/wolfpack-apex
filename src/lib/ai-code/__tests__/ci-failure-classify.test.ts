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

describe("the guardrail CLASS is governance (covers guardrails we add later)", () => {
  it.each([
    ["no-sql-injection", "FAIL src/lib/db/__tests__/no-sql-injection.test.ts"],
    ["no-em-dashes", "FAIL src/__tests__/no-em-dashes.test.ts"],
    ["a *-coverage test", "FAIL src/__tests__/route-coverage.test.ts"],
    ["a *-guard test", "FAIL src/lib/__tests__/analytics-guard.test.ts"],
    ["a *-posture test", "FAIL src/__tests__/tls-hybrid-posture.test.ts"],
    ["american-english", "FAIL src/__tests__/american-english.test.ts"],
    ["db-workspace-scope", "FAIL src/lib/__tests__/db-workspace-scope.test.ts"],
    ["audit-log-immutable", "FAIL src/lib/__tests__/audit-log-immutable.test.ts"],
  ])("a failing guardrail file is governance: %s", (_label, detail) => {
    const c = classifyCiFailure(detail, []);
    expect(c.kind).toBe("governance");
    expect(c.signal).toMatch(/guardrail:/);
  });

  it.each([
    ["must import", "Route x has a mutation handler but must import recordAudit"],
    ["is not registered", "Event 'foo.bar' is not registered in InstinctEventType"],
    ["add an entry to the allowlist", "add an entry to the allowlist with a reason"],
    ["is forbidden", "raw fetch is forbidden for authenticated routes"],
  ])("an actionable policy ask is governance: %s", (_label, detail) => {
    expect(classifyCiFailure(detail, []).kind).toBe("governance");
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

describe("transient/infra failures re-run, never auto-fix", () => {
  it.each([
    ["timeout", "The operation was canceled. timed out after 360000ms"],
    ["OOM", "FATAL ERROR: JavaScript heap out of memory"],
    ["lost runner", "The runner has received a shutdown signal"],
    ["network", "npm ERR! network ETIMEDOUT"],
    ["registry 503", "npm ERR! 503 Service Unavailable"],
    ["docker", "Cannot connect to the Docker daemon"],
  ])("classifies as transient: %s", (_label, detail) => {
    const c = classifyCiFailure(detail, []);
    expect(c.kind).toBe("transient");
    expect(c.signal.length).toBeGreaterThan(0);
  });
  it("a real assertion failure is NOT transient", () => {
    expect(classifyCiFailure("Expected 5 Received 4", ["unit"]).kind).toBe("mechanical");
  });
});
