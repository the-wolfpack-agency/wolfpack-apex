/**
 * The ratchet is tested, because an untested guardrail is the thing it guards
 * against. Every failure this repo found on 2026-08-24 was a check that
 * reported health: a probe reading a splash, a soft step that could not fail,
 * a spec gated on a secret nobody set.
 */
import { parseResults, compare, normalizeFile } from "../soft-spec-ratchet";

/** Playwright's shape, trimmed to what the parser reads. */
const report = (specs: Array<[string, string]>) => ({
  suites: [
    {
      title: "tests/e2e/a.spec.ts",
      file: "tests/e2e/a.spec.ts",
      suites: [
        {
          title: "a suite",
          file: "tests/e2e/a.spec.ts",
          specs: specs.map(([title, status]) => ({ title, tests: [{ status }] })),
        },
      ],
    },
  ],
});

const K = "tests/e2e/a.spec.ts › a suite › ";

describe("parseResults", () => {
  it("keys on titles, not line numbers, and drops the file-level suite title", () => {
    const out = parseResults(report([["one", "expected"]]));
    expect(out).toEqual([{ key: `${K}one`, status: "passed" }]);
  });

  it("reads each status Playwright can report", () => {
    const out = parseResults(
      report([
        ["ok", "expected"],
        ["broken", "unexpected"],
        ["retried", "flaky"],
        ["not run", "skipped"],
      ]),
    );
    expect(out.map((o) => o.status)).toEqual(["passed", "failed", "flaky", "skipped"]);
  });

  it("returns nothing for an empty report, so the caller can refuse to pass", () => {
    expect(parseResults({ suites: [] })).toEqual([]);
    expect(parseResults({})).toEqual([]);
  });
});

describe("compare", () => {
  const baseline = { [`${K}broken`]: "known, being fixed" };

  it("tolerates a failure that is on the list", () => {
    const r = compare(parseResults(report([["broken", "unexpected"]])), baseline);
    expect(r.knownFailures).toEqual([`${K}broken`]);
    expect(r.newFailures).toEqual([]);
  });

  it("catches a failure that is not on the list", () => {
    const r = compare(parseResults(report([["fresh", "unexpected"]])), baseline);
    expect(r.newFailures).toEqual([`${K}fresh`]);
  });

  it("says when a listed failure starts passing, so the entry can be removed", () => {
    const r = compare(parseResults(report([["broken", "expected"]])), baseline);
    expect(r.nowPassing).toEqual([`${K}broken`]);
    // A fix must never fail the build.
    expect(r.newFailures).toEqual([]);
  });

  it("notices a baselined test that did not run at all", () => {
    const r = compare(parseResults(report([["other", "expected"]])), baseline);
    expect(r.missing).toEqual([`${K}broken`]);
  });

  it("does not treat a flaky pass as a failure", () => {
    const r = compare(parseResults(report([["retried", "flaky"]])), baseline);
    expect(r.newFailures).toEqual([]);
    expect(r.flaky).toEqual([`${K}retried`]);
  });

  it("does not treat a skipped test as a pass that clears the baseline", () => {
    // A skipped Playwright test reports as a pass. If that pruned the baseline,
    // a spec quietly skipping would look like a spec quietly fixed.
    const r = compare(parseResults(report([["broken", "skipped"]])), baseline);
    expect(r.nowPassing).toEqual([]);
    expect(r.newFailures).toEqual([]);
  });
});

describe("normalizeFile", () => {
  // Playwright reports paths relative to testDir. A baseline written in the
  // repo-relative form would have matched nothing, and every known failure
  // would have read as new. This is why the parser was run against a real
  // report before the baseline was written.
  it("accepts the form Playwright actually emits", () => {
    expect(normalizeFile("agents-onboarding.spec.ts")).toBe(
      "tests/e2e/agents-onboarding.spec.ts",
    );
  });

  it("leaves an already repo-relative path alone", () => {
    expect(normalizeFile("tests/e2e/agents-onboarding.spec.ts")).toBe(
      "tests/e2e/agents-onboarding.spec.ts",
    );
  });

  it("handles an absolute path from a CI runner", () => {
    expect(normalizeFile("/home/runner/work/apex/tests/e2e/x.spec.ts")).toBe(
      "tests/e2e/x.spec.ts",
    );
  });
});
