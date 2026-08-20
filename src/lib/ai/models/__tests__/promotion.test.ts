/**
 * The promotion gate.
 *
 * Two opposite failures, and both are expensive.
 *
 * Letting a regressed model keep serving is the one this exists to stop: the
 * client's answers get worse and the only trace is a dashboard nobody opened.
 *
 * Blocking a model that was fine is worse in the moment, because it is an
 * outage. So the default is permissive, silence never promotes and never
 * demotes, and quarantine follows evidence or a person, never a guess.
 */
import { decide, mayServe, substituteFor, type PromotionRecord } from "../promotion";

const record = (modelId: string, over: Partial<PromotionRecord> = {}): PromotionRecord => ({
  modelId,
  version: null,
  state: "approved",
  reason: "",
  decidedBy: null,
  ...over,
});

describe("decide", () => {
  it("quarantines a model measured worse than the one it replaced", () => {
    const d = decide({ current: "approved", verdict: "regressed" });
    expect(d.state).toBe("quarantined");
    expect(d.changed).toBe(true);
    expect(d.reason).toMatch(/fell measurably/i);
  });

  it("promotes a candidate that held or improved", () => {
    expect(decide({ current: "candidate", verdict: "stable" }).state).toBe("approved");
    expect(decide({ current: "candidate", verdict: "improved" }).state).toBe("approved");
  });

  it("does NOT un-quarantine on a later good sample", () => {
    /* A model stopped by a person or by a measured regression comes back by
       decision, not by a run of luck on the next batch. */
    const d = decide({ current: "quarantined", verdict: "improved" });
    expect(d.state).toBe("quarantined");
    expect(d.changed).toBe(false);
  });

  it("treats thin evidence as no evidence, in both directions", () => {
    // Not enough data is not a finding. It must neither promote nor demote.
    expect(decide({ current: "approved", verdict: "insufficient_data" }).state).toBe("approved");
    expect(decide({ current: "candidate", verdict: "insufficient_data" }).state).toBe("candidate");
    expect(decide({ current: "quarantined", verdict: "insufficient_data" }).state).toBe("quarantined");
    expect(decide({ current: "approved", verdict: "insufficient_data" }).changed).toBe(false);
  });

  it("lets a person overrule the evidence, in both directions", () => {
    /* An operator who has read a regression and accepted it must be able to say
       so, and one who distrusts a model that scores well must be able to stop
       it. A system that argues with the person accountable for it gets turned
       off wholesale. */
    const accepted = decide({
      current: "quarantined",
      verdict: "regressed",
      override: { state: "approved", by: "cto", reason: "Regression is in a task mix we retired" },
    });
    expect(accepted.state).toBe("approved");
    expect(accepted.reason).toMatch(/decided by cto/);

    const stopped = decide({
      current: "approved",
      verdict: "improved",
      override: { state: "quarantined", by: "cto", reason: "Provider incident" },
    });
    expect(stopped.state).toBe("quarantined");
  });

  it("reports whether the state actually moved", () => {
    // Callers write an audit row on change. A no-op logged as a change is noise
    // that makes a real change harder to find.
    expect(decide({ current: "quarantined", verdict: "regressed" }).changed).toBe(false);
    expect(decide({ current: "approved", verdict: "stable" }).changed).toBe(false);
  });
});

describe("mayServe", () => {
  it("allows a model nobody has ruled on", () => {
    /* Fail open. Refusing every unrecorded model would take down every
       deployment the day this shipped, on an estate where nothing has been
       evaluated yet. */
    expect(mayServe("gpt-4o-mini", []).allowed).toBe(true);
  });

  it("allows an approved model", () => {
    expect(mayServe("gpt-4o", [record("gpt-4o")]).allowed).toBe(true);
  });

  it("refuses a quarantined model and says why", () => {
    const r = mayServe("gpt-4o", [
      record("gpt-4o", { state: "quarantined", reason: "Task success fell." }),
    ]);
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("Task success fell.");
  });

  it("refuses a candidate, which may be measured but not used", () => {
    expect(mayServe("new-model", [record("new-model", { state: "candidate" })]).allowed).toBe(false);
  });
});

describe("substituteFor", () => {
  const records = [record("gpt-4o", { state: "quarantined", reason: "regressed" })];

  it("returns the cheapest allowed replacement, following the caller's order", () => {
    expect(substituteFor("gpt-4o", ["gpt-4o", "gpt-4o-mini", "claude-haiku-4-5"], records)).toBe(
      "gpt-4o-mini",
    );
  });

  it("never substitutes the blocked model for itself", () => {
    expect(substituteFor("gpt-4o", ["gpt-4o"], records)).toBeNull();
  });

  it("skips other blocked models", () => {
    const both = [
      ...records,
      record("gpt-4o-mini", { state: "quarantined", reason: "also regressed" }),
    ];
    expect(substituteFor("gpt-4o", ["gpt-4o-mini", "claude-haiku-4-5"], both)).toBe(
      "claude-haiku-4-5",
    );
  });

  it("returns null rather than resolving the problem by ignoring the gate", () => {
    /* Nothing eligible is a state the caller must report. Falling back to the
       blocked model would make the whole gate decorative. */
    const all = [
      record("a", { state: "quarantined", reason: "x" }),
      record("b", { state: "quarantined", reason: "x" }),
    ];
    expect(substituteFor("a", ["b"], all)).toBeNull();
  });
});
