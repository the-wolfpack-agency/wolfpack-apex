/**
 * The mechanical-vs-governance classifier decides whether a CI failure is safe
 * to auto-repair (mechanical) or must go to a human (governance/policy gate).
 * Getting this wrong in the "governance -> mechanical" direction is the dangerous
 * case (an autofixer editing code to make a guardrail pass), so the tests pin the
 * governance signals hard.
 */
import { classifyCiFailure, isDeployInfraCheck, failuresAreInfraOnly, isDependencyAuditFailure } from "@/lib/ai-code/ci-failure-classify";

describe("dependency-audit is a governance gate with a DETERMINISTIC fix (dispatch, do not model-fix)", () => {
  it("recognizes the dependency-audit check so the loop can dispatch the no-model dep-fixer", () => {
    expect(isDependencyAuditFailure(["Dependency Audit"])).toBe(true);
    expect(isDependencyAuditFailure(["unit-tests", "Dependency Audit"])).toBe(true);
  });
  it("is still classified governance (a model must never hack a security gate)", () => {
    expect(classifyCiFailure("1 high severity vulnerability", ["Dependency Audit"]).kind).toBe("governance");
  });
  it("does not fire on unrelated checks", () => {
    expect(isDependencyAuditFailure(["unit-tests", "lint-types"])).toBe(false);
  });
});

describe("deploy/infra vs code check typing (for empty-detail escalation)", () => {
  it.each(["e2e", "vercel-deploy", "preflight", "canary-deploy", "Playwright", "Vercel"])("treats %s as deploy/infra", (name) => {
    expect(isDeployInfraCheck(name)).toBe(true);
  });
  it.each(["unit (3/4)", "lint-types", "type-check", "tsc", "build", "jest", "agenticqa-full-pipeline", "CodeQL"])("does NOT treat %s as deploy/infra", (name) => {
    expect(isDeployInfraCheck(name)).toBe(false);
  });
  it("code wins ties: a check named for both code and deploy is code", () => {
    expect(isDeployInfraCheck("unit-e2e")).toBe(false); // has 'unit' -> code
  });
  it("failuresAreInfraOnly: true only when EVERY failing check is infra", () => {
    expect(failuresAreInfraOnly(["e2e", "vercel-deploy"])).toBe(true);
    expect(failuresAreInfraOnly(["e2e", "unit (3/4)"])).toBe(false); // a code check is present
    expect(failuresAreInfraOnly(["unit (3/4)", "lint-types"])).toBe(false);
    expect(failuresAreInfraOnly([])).toBe(false); // nothing failing -> not "infra-only"
  });
});

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

describe("mechanical subtypes (route each shape)", () => {
  const { mechanicalSubtype } = jest.requireActual("@/lib/ai-code/ci-failure-classify");
  it.each([
    ["type", "error TS2322: Type 'string' is not assignable to type 'number'"],
    ["type", "Parameter 'file' implicitly has an 'any' type."],
    ["import", "Cannot find module '@/lib/x' or its corresponding type declarations"],
    ["snapshot", "1 snapshot failed. Inspect your code changes or press `u` to update them."],
    ["coverage", "Jest: Coverage for lines (78%) does not meet threshold (80%)"],
    ["lint", "error  'x' is assigned a value but never used  @typescript-eslint/no-unused-vars"],
    ["build", "Failed to compile."],
    ["test", "Expected 5 Received 4"],
  ])("classifies subtype %s", (subtype, detail) => {
    expect(mechanicalSubtype(detail)).toBe(subtype);
    expect(classifyCiFailure(detail, []).subtype).toBe(subtype);
  });
});
