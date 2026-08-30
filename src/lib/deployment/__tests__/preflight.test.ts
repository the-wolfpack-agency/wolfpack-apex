/**
 * Is this deployment ready to hand to a client?
 *
 * Everything verified today was verified against OUR instance: our documents,
 * our connectors, an account months old. A fresh client deployment shares none
 * of that, and the failures it hits are the ones nobody sees because our
 * instance passed them long ago.
 *
 * The two things this has to get right are ordering and the empty/broken
 * distinction, and both are easy to get wrong in a way that looks fine.
 */
import {
  assessPreflight,
  describePreflight,
  type Check,
} from "@/lib/deployment/preflight";

const check = (over: Partial<Check> & Pick<Check, "id">): Check => ({
  proves: "something",
  state: "ok",
  detail: "fine",
  blocks: [],
  ...over,
});

describe("readiness", () => {
  it("is ready only when every actionable check passes", () => {
    expect(assessPreflight([check({ id: "a" }), check({ id: "b" })]).readyToHandOver).toBe(true);
  });

  /* NEEDS_SETUP IS NOT READY. A new deployment with no documents is working
     correctly and cannot be handed over, and collapsing those two is how an
     instance gets demoed empty. */
  it("is not ready when something still needs setting up", () => {
    const p = assessPreflight([check({ id: "corpus", state: "needs_setup" })]);
    expect(p.readyToHandOver).toBe(false);
  });

  /* UNKNOWN IS NEVER READY. A check that could not run has not passed, and
     treating it as a pass is how an unverified instance ships. */
  it("is not ready when a check could not be determined", () => {
    expect(assessPreflight([check({ id: "x", state: "unknown" })]).readyToHandOver).toBe(false);
  });
});

describe("ordering, which is most of the value", () => {
  /* An instance with no database cannot have a corpus. Reporting both as
     independent failures sends somebody to fix the last one first, and one
     root cause becomes five tickets. */
  it("does not count a check that its blocker made impossible", () => {
    const p = assessPreflight([
      check({ id: "db", proves: "database reachable", state: "broken", blocks: ["corpus"] }),
      check({ id: "corpus", proves: "documents indexed", state: "broken" }),
    ]);
    expect(p.todo[0]).toMatch(/database reachable/);
    expect(p.todo.filter((t) => !t.startsWith("(after"))).toHaveLength(1);
  });

  it("still mentions the blocked check, after the thing blocking it", () => {
    const p = assessPreflight([
      check({ id: "db", proves: "database", state: "broken", blocks: ["corpus"] }),
      check({ id: "corpus", proves: "documents", state: "broken" }),
    ]);
    expect(p.todo.at(-1)).toMatch(/^\(after the above\).*documents/);
  });

  /* Broken before unknown before needs_setup: a thing that is wrong outranks a
     thing that is merely unfinished. */
  it("puts what is wrong before what is unfinished", () => {
    const p = assessPreflight([
      check({ id: "a", proves: "setup thing", state: "needs_setup" }),
      check({ id: "b", proves: "broken thing", state: "broken" }),
      check({ id: "c", proves: "unknown thing", state: "unknown" }),
    ]);
    expect(p.todo[0]).toMatch(/broken thing/);
    expect(p.todo[1]).toMatch(/unknown thing/);
    expect(p.todo[2]).toMatch(/setup thing/);
  });

  it("stops counting a blocked check once its blocker is fixed", () => {
    const p = assessPreflight([
      check({ id: "db", state: "ok", blocks: ["corpus"] }),
      check({ id: "corpus", proves: "documents", state: "needs_setup" }),
    ]);
    expect(p.readyToHandOver).toBe(false);
    expect(p.todo[0]).toMatch(/documents/);
  });
});

describe("the handover note", () => {
  it("says plainly when it is ready", () => {
    expect(describePreflight(assessPreflight([check({ id: "a" })])).join("\n")).toContain(
      "Ready to hand over",
    );
  });

  /* Distinguishes the two failure kinds in the output, not just internally:
     somebody reading the note has to know whether to configure or to debug. */
  it("marks a setup gap differently from a fault", () => {
    const out = describePreflight(
      assessPreflight([
        check({ id: "a", proves: "corpus", state: "needs_setup", detail: "no documents yet" }),
        check({ id: "b", proves: "database", state: "broken", detail: "cannot connect" }),
      ]),
    ).join("\n");
    expect(out).toMatch(/todo\s+corpus/);
    expect(out).toMatch(/FAIL\s+database/);
  });
});
