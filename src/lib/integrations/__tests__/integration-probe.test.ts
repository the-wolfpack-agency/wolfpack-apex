/**
 * A diagnostic that reports findings it did not observe is worse than none.
 *
 * The first run of the probe printed a confident table: three surfaces
 * "genuinely broken", two "working". Not one verdict had touched Microsoft.
 * Every stored token was expired and the client credentials were absent, so
 * getValidToken returned null for everybody; the failures were that one
 * missing credential, the successes were reads from the Postgres cache, and
 * one "crash" was the probe's own summarizer calling .slice on an error shape
 * it did not recognize.
 *
 * Nobody would have known. The table looked exactly like a real result, and
 * acting on it would have meant debugging healthy integrations and telling a
 * client that working surfaces were broken.
 *
 * These pin the three rules that came out of that: read both error shapes,
 * never call a cache hit proof of a live integration, and treat an empty
 * result as different from a failure.
 */
import { classify, type ProbeResult } from "../probe";

describe("reading an integration's answer", () => {
  it("treats an empty list as working with nothing to say, not as broken", () => {
    /* An account with no OneNote notebooks returns []. Calling that broken
       sends somebody to debug a healthy path. */
    expect(classify([])).toBe("empty");
    expect(classify([{ id: "1" }])).toBe("works");
  });

  /* TWO ERROR SHAPES LIVE IN THIS REPO, and reading only one is the bug that
     made a correctly-typed Planner refusal look like a crash. */
  it("understands the { error: { kind } } shape", () => {
    expect(classify({ ok: false, error: { kind: "scope_missing" } })).toBe("scope_missing");
    expect(classify({ ok: false, error: { kind: "service_unavailable" } })).toBe("failed");
  });

  it("understands the { code } shape as well", () => {
    expect(classify({ ok: false, code: "not_connected", message: "no_valid_token" })).toBe("failed");
  });

  /* A missing consent is a permission to grant, not a defect to fix, and
     conflating them sends an engineer after an admin's job. */
  it("separates a missing consent from a real failure", () => {
    expect(classify({ ok: false, code: "forbidden" })).toBe("scope_missing");
  });

  it("does not throw on an unfamiliar shape", () => {
    expect(() => classify({ ok: false })).not.toThrow();
    expect(() => classify(undefined)).not.toThrow();
    expect(() => classify(null)).not.toThrow();
  });
});

describe("what a verdict is allowed to claim", () => {
  /* The vocabulary itself carries the rule: there is a word for "answered
     from cache", so a cache hit cannot be recorded as a live integration. */
  it("has a verdict distinct from works for a cache-backed read", () => {
    const cached: ProbeResult = { label: "Directory", verdict: "cache", detail: "5 users" };
    expect(cached.verdict).not.toBe("works");
  });
});
