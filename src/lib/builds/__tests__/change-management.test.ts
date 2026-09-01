/**
 * The figures in the concept are the figures that were measured.
 *
 * This document's whole argument is that we measured their process and they
 * have not. A number that drifts from the walk turns that into a liability in
 * the room where it gets presented, so the ones a reader could check are
 * pinned here.
 */

import {
  CANDOUR_CONSTRAINT,
  COMMITMENT_STATES,
  CONFIGURATION,
  EVIDENCE,
  FINDINGS,
  FLOW,
  IMPROVEMENTS,
  OPEN_QUESTIONS,
  PLANS_PER_CYCLE,
  REUSED,
  SIBLING_MODULE,
  THEIR_DESCRIPTION,
} from "@/lib/builds/change-management";

describe("what was measured on their tenant", () => {
  it("holds the walk's figures", () => {
    expect(EVIDENCE.surfacesWalked).toBe(39);
    expect(EVIDENCE.formsFound).toBe(13);
    expect(EVIDENCE.changePlanForms).toBe(3);
    expect(EVIDENCE.vendorScreens).toBe(38);
    expect(EVIDENCE.thirdPartyHosts).toBe(7);
  });

  it("derives the volume rather than stating it", () => {
    /* 320 is the number somebody will repeat in a meeting. It has to come
       from the two figures in their strategy deck, not from a memory of it. */
    expect(PLANS_PER_CYCLE).toBe(EVIDENCE.ba102Classes * EVIDENCE.participantsPerClass);
    expect(PLANS_PER_CYCLE).toBe(320);
  });

  it("quotes their description rather than paraphrasing it", () => {
    expect(THEIR_DESCRIPTION).toMatch(/share your plan with managers/);
    expect(THEIR_DESCRIPTION).toMatch(/update it as you go/);
    expect(THEIR_DESCRIPTION).toMatch(/discuss during coaching/);
  });
});

describe("the finding the design follows from", () => {
  /* THE WHOLE ARGUMENT IN ONE ASSERTION. If a form held most of the process,
     replacing the form would be the wrong project. */
  it("shows that only the first of four moments is a form", () => {
    expect(FLOW).toHaveLength(4);
    expect(FLOW.filter((f) => f.heldByAForm)).toHaveLength(1);
    expect(FLOW[0].heldByAForm).toBe(true);
  });

  it("gives every finding something checkable under it", () => {
    expect(FINDINGS.length).toBeGreaterThanOrEqual(5);
    for (const f of FINDINGS) {
      expect(f.evidence.length).toBeGreaterThan(15);
      /* A finding whose evidence carries no figure is an opinion with a
         label on it. */
      expect(f.evidence).toMatch(/\d/);
    }
  });
});

describe("the commitment state machine", () => {
  /* SILENCE IS THE FAILURE MODE, so it has to be a state. A model where an
     untouched plan and a thriving one sit in the same state cannot see the
     thing the whole system exists to catch. */
  it("makes doing nothing visible", () => {
    expect(COMMITMENT_STATES.map((s) => s.name)).toContain("overdue");
  });

  /* Replacing a commitment with a better one is not a failure, and a model
     that cannot say so will be gamed by everyone who uses it. */
  it("separates abandoned from changed", () => {
    const names = COMMITMENT_STATES.map((s) => s.name);
    expect(names).toContain("closed: changed");
    expect(names).toContain("closed: abandoned");
  });

  it("says what moves every state on", () => {
    for (const s of COMMITMENT_STATES) expect(s.leaves.length).toBeGreaterThan(8);
  });
});

describe("the argument for replacing it", () => {
  it("ties every change to a question it makes answerable", () => {
    expect(IMPROVEMENTS.length).toBeGreaterThanOrEqual(6);
    for (const im of IMPROVEMENTS) {
      expect(im.now.length).toBeGreaterThan(20);
      expect(im.proposed.length).toBeGreaterThan(20);
      /* A feature with no question under it is a feature nobody asked for. */
      expect(im.unlocks.length).toBeGreaterThan(20);
    }
  });

  /* A plan is somebody writing down what they are bad at. It is honest only
     while it is not surveillance, and 320 identical safe answers is the
     failure this constraint prevents. */
  it("keeps the cohort above the manager to counts and themes", () => {
    expect(CANDOUR_CONSTRAINT).toMatch(/counts and recurring themes/i);
    expect(CANDOUR_CONSTRAINT).toMatch(/recorded/i);
  });

  it("names the module that shares the name and does not fit", () => {
    expect(SIBLING_MODULE).toMatch(/wolfpack-auto/);
    expect(SIBLING_MODULE).toMatch(/organizational/i);
    expect(SIBLING_MODULE).toMatch(/personal/i);
  });

  it("configures per program rather than per product", () => {
    expect(CONFIGURATION.length).toBeGreaterThanOrEqual(5);
    expect(CONFIGURATION.map((c) => c.setting).join(" ")).toMatch(/cadence/i);
  });

  it("reuses what is already built", () => {
    const have = REUSED.map((r) => r.have).join(" ");
    expect(have).toMatch(/audit/i);
    expect(have).toMatch(/redaction/i);
  });
});

describe("what the concept admits it does not know", () => {
  /* THE ONE THAT MATTERS. The walk could not read the plan's fields, so a
     schema here would be invented. Dropping this question would be the
     document's only dishonest moment. */
  it("says the plan's own fields have not been read", () => {
    const qs = OPEN_QUESTIONS.map((q) => `${q.question} ${q.why}`).join(" ");
    expect(qs).toMatch(/what does the plan actually ask/i);
    expect(qs).toMatch(/without form elements/i);
  });

  it("explains why each is open rather than just listing it", () => {
    for (const q of OPEN_QUESTIONS) expect(q.why.length).toBeGreaterThan(60);
  });
});
