/**
 * The read-CI-and-fix loop decision. Every branch is a real operational state:
 * green, running, failed-with-budget, failed-out-of-budget. Bounded so it can
 * never loop forever.
 */
import { decideFixAction, buildFixBrief } from "../ci-fix-loop";
import type { CiSummary } from "../ci-status";

const ci = (over: Partial<CiSummary>): CiSummary => ({
  total: 3, passed: 3, failed: 0, pending: 0, complete: true, ciComplete: true, failedChecks: [], failedDetails: [], ...over,
});

describe("decideFixAction", () => {
  it("green -> merge_ready", () => {
    expect(decideFixAction({ ci: ci({}), attempt: 0, maxAttempts: 3 }).action).toBe("merge_ready");
  });
  it("still running -> wait (never author on a moving target)", () => {
    const d = decideFixAction({ ci: ci({ complete: false, ciComplete: false, pending: 2 }), attempt: 0, maxAttempts: 3 });
    expect(d.action).toBe("wait");
  });
  it("failed with budget left -> author_fix", () => {
    const d = decideFixAction({
      ci: ci({ complete: true, ciComplete: false, failed: 1, failedChecks: ["unit"] }),
      attempt: 1,
      maxAttempts: 3,
    });
    expect(d.action).toBe("author_fix");
    expect(d.reason).toMatch(/attempt 2\/3/);
  });
  it("failed with budget spent -> escalate_human (never loops forever)", () => {
    const d = decideFixAction({
      ci: ci({ complete: true, ciComplete: false, failed: 1, failedChecks: ["unit"] }),
      attempt: 3,
      maxAttempts: 3,
    });
    expect(d.action).toBe("escalate_human");
  });
});

describe("decideFixAction, baseline-aware", () => {
  const red = ci({ complete: true, ciComplete: false, failed: 1, failedChecks: ["e2e"] });
  it("authors a fix when the change INTRODUCED failing checks (budget left)", () => {
    const d = decideFixAction({ ci: red, attempt: 0, maxAttempts: 3, introducedFailing: 1 });
    expect(d.action).toBe("author_fix");
  });
  it("does NOT author a fix when every failure is pre-existing (introduced = 0)", () => {
    const d = decideFixAction({ ci: red, attempt: 0, maxAttempts: 3, introducedFailing: 0 });
    expect(d.action).toBe("escalate_human");
    expect(d.reason).toMatch(/already failing on the base branch|pre-existing/i);
  });
  it("without attribution (undefined) keeps the baseline-unaware behavior: fix any red", () => {
    const d = decideFixAction({ ci: red, attempt: 0, maxAttempts: 3 });
    expect(d.action).toBe("author_fix");
  });
});

describe("buildFixBrief", () => {
  it("lists each failed check with its summary and forbids weakening tests", () => {
    const brief = buildFixBrief([
      { name: "unit (2/4)", summary: "audit-coverage: route has a mutation but no recordAudit" },
      { name: "lint", summary: "" },
    ]);
    expect(brief).toMatch(/without weakening any test or gate/i);
    expect(brief).toMatch(/unit \(2\/4\).*audit-coverage/);
    expect(brief).toMatch(/- lint/);
  });
  it("degrades to a clear message when no detail was reported", () => {
    expect(buildFixBrief([])).toMatch(/no per-check detail/i);
  });
});

describe("decideFixAction, unreadable CI", () => {
  it("does not pretend 'still running' when CI could not be read - escalates with the reason", () => {
    const d = decideFixAction({
      ci: ci({ readable: false, unreadableReason: "cannot read CI check runs - the token lacks Checks: read" }),
      attempt: 0,
      maxAttempts: 3,
    });
    expect(d.action).toBe("escalate_human");
    expect(d.reason).toMatch(/Checks: read|cannot read CI/i);
  });
});

describe("governance failure escalates (not auto-fixed)", () => {
  const redComplete = { total: 2, passed: 1, failed: 1, pending: 0, complete: true, ciComplete: false, readable: true, failedChecks: ["CodeQL"], failedDetails: [{ name: "CodeQL", summary: "alert" }] };
  it("escalates with the governance signal even with budget remaining", () => {
    const d = decideFixAction({ ci: redComplete as never, attempt: 0, maxAttempts: 3, introducedFailing: 1, governanceFailure: { signal: "check:CodeQL" } });
    expect(d.action).toBe("escalate_human");
    expect(d.reason).toMatch(/governance\/policy gate/i);
    expect(d.reason).toMatch(/check:CodeQL/);
  });
  it("authors a fix when the failure is NOT governance", () => {
    const d = decideFixAction({ ci: redComplete as never, attempt: 0, maxAttempts: 3, introducedFailing: 1 });
    expect(d.action).toBe("author_fix");
  });
});

describe("transient/infra failure re-runs (escalates), never authored", () => {
  const redComplete = { total: 2, passed: 1, failed: 1, pending: 0, complete: true, ciComplete: false, readable: true, failedChecks: ["unit"], failedDetails: [{ name: "unit", summary: "x" }] };
  it("escalates with the infra reason", () => {
    const d = decideFixAction({ ci: redComplete as never, attempt: 0, maxAttempts: 3, introducedFailing: 1, transientFailure: { signal: "ETIMEDOUT" } });
    expect(d.action).toBe("escalate_human");
    expect(d.reason).toMatch(/infrastructure\/transient/i);
    expect(d.reason).toMatch(/ETIMEDOUT/);
  });
});

describe("flake recheck waits before authoring", () => {
  const redComplete = { total: 2, passed: 1, failed: 1, pending: 0, complete: true, ciComplete: false, readable: true, failedChecks: ["unit"], failedDetails: [{ name: "unit", summary: "x" }] };
  it("waits (does not author) right after a re-run was triggered", () => {
    const d = decideFixAction({ ci: redComplete as never, attempt: 0, maxAttempts: 3, introducedFailing: 1, flakeRecheckTriggered: true });
    expect(d.action).toBe("wait");
    expect(d.reason).toMatch(/rule out a flake/i);
  });
});

describe("snapshot failures escalate (never auto-update)", () => {
  const redComplete = { total: 2, passed: 1, failed: 1, pending: 0, complete: true, ciComplete: false, readable: true, failedChecks: ["unit"], failedDetails: [{ name: "unit", summary: "x" }] };
  it("escalates a snapshot failure with budget remaining", () => {
    const d = decideFixAction({ ci: redComplete as never, attempt: 0, maxAttempts: 3, introducedFailing: 1, snapshotFailure: true });
    expect(d.action).toBe("escalate_human");
    expect(d.reason).toMatch(/SNAPSHOT/);
    expect(d.reason).toMatch(/mask a regression/i);
  });
});
