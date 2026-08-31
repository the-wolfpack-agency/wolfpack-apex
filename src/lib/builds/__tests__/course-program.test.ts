/**
 * The claims about their program are the claims their material makes.
 *
 * This document argues that we understand a course well enough to rebuild its
 * method for somebody else. That argument dies the moment a figure or a quote
 * turns out to be from memory, so the checkable parts are pinned here.
 */

import {
  CANDOR_CONSTRAINT,
  COMMITMENT_LADDER,
  COMPONENTS,
  CONFIGURATION,
  COPYRIGHT_LINE,
  CORPUS,
  DELIVERABLES,
  HEADLINE,
  IMPROVEMENTS,
  IP_POSITION,
  OPEN_QUESTIONS,
  REUSED,
} from "@/lib/builds/course-program";

describe("what we are allowed to take", () => {
  /* THE MOST IMPORTANT ASSERTION ON THE PAGE. Softening this line, or losing
     it in an edit, turns a careful document into a liability. */
  it("quotes their copyright notice rather than summarizing it", () => {
    expect(COPYRIGHT_LINE).toMatch(/Porsche Cars North America/);
    expect(COPYRIGHT_LINE).toMatch(/cannot be copied or distributed/);
  });

  it("states the position plainly and sends ownership of the method to the contract", () => {
    expect(IP_POSITION).toMatch(/method transfers/i);
    expect(IP_POSITION).toMatch(/materials do not/i);
    /* Who owns the instructional design is a legal question, and a page that
       answered it would be guessing about something expensive. */
    expect(IP_POSITION).toMatch(/contract/i);
  });

  /* Every component has to declare what happens to it. A component with no
     answer is the one somebody copies by accident. */
  it("says of every component whether it travels", () => {
    expect(COMPONENTS.length).toBeGreaterThanOrEqual(10);
    for (const c of COMPONENTS) {
      expect(["structure", "structure and wording", "not at all"]).toContain(c.transfers);
      expect(c.becomes.trim()).not.toBe("");
    }
  });

  /* "Unchanged" is a complete answer for something that travels as written.
     It is not a complete answer for something that has to be rebuilt, and the
     rebuilds are where the money goes, so those have to say what replaces
     them. */
  it("explains the replacement for anything that cannot be reused", () => {
    for (const c of COMPONENTS.filter((x) => x.transfers !== "structure and wording")) {
      expect(c.becomes.length).toBeGreaterThan(30);
    }
  });

  it("marks the branded content modules as a rebuild", () => {
    const modules = COMPONENTS.find((c) => c.name === "Content modules");
    expect(modules?.transfers).toBe("not at all");
  });
});

describe("the finding the whole document rests on", () => {
  /* The value is the ORDER, not the parts. A ladder with a rung missing is a
     pile of worksheets, which is how this gets rebuilt badly. */
  it("keeps the ladder in the order the artifacts feed each other", () => {
    expect(COMMITMENT_LADDER).toHaveLength(6);
    const joined = COMMITMENT_LADDER.join(" | ").toLowerCase();
    expect(joined.indexOf("notes")).toBeLessThan(joined.indexOf("swot"));
    expect(joined.indexOf("swot")).toBeLessThan(joined.indexOf("smart"));
    expect(joined.indexOf("smart")).toBeLessThan(joined.indexOf("change management plan"));
    expect(joined.indexOf("change management plan")).toBeLessThan(joined.indexOf("capstone"));
    expect(joined.indexOf("capstone")).toBeLessThan(joined.indexOf("coaching"));
  });

  it("opens by saying the slides are not the thing", () => {
    expect(HEADLINE).toMatch(/not the slides/i);
  });
});

describe("what the corpus actually showed", () => {
  it("holds the counts that were read, not remembered", () => {
    expect(CORPUS.facilitatorGuides).toBe(8);
    expect(CORPUS.courseDays).toBe(4);
    expect(CORPUS.levels).toBe(4);
    expect(CORPUS.mobileCoachRules).toBe(115);
  });

  /* THE CORRECTION. An earlier version of this work said nobody follows up and
     silence is the failure mode. The corpus says otherwise: an SMS coach that
     checks in weekly for a year. Losing that correction would put a claim on a
     client's desk that their own material contradicts. */
  it("credits the follow-through that already exists", () => {
    const coach = COMPONENTS.find((c) => c.name === "Mobile coach");
    expect(coach).toBeDefined();
    expect(coach!.purpose).toMatch(/weekly/i);
    expect(coach!.purpose).toMatch(/year/i);

    const improvement = IMPROVEMENTS.find((i) => /coach does not know/i.test(i.title));
    /* The gap is what it asks, not that it is missing. */
    expect(improvement?.today).toMatch(/how valuable the program was/i);
  });
});

describe("the argument for our version", () => {
  it("ties every improvement to something measured and something it unlocks", () => {
    expect(IMPROVEMENTS.length).toBeGreaterThanOrEqual(5);
    for (const im of IMPROVEMENTS) {
      expect(im.today.length).toBeGreaterThan(30);
      expect(im.proposed.length).toBeGreaterThan(30);
      expect(im.why.length).toBeGreaterThan(30);
    }
  });

  it("separates satisfaction from follow-through", () => {
    const evaluation = IMPROVEMENTS.find((i) => /evaluation/i.test(i.title));
    /* A course can be rated excellent by everyone who attended and change
       nothing. Only one of those is currently visible. */
    expect(evaluation?.why).toMatch(/change nothing/i);
  });

  it("keeps a cohort above the manager to counts and themes", () => {
    expect(CANDOR_CONSTRAINT).toMatch(/counts and recurring themes/i);
    expect(CANDOR_CONSTRAINT).toMatch(/recorded/i);
  });

  it("breaks the deliverable up so part of it can be bought", () => {
    expect(DELIVERABLES.length).toBeGreaterThanOrEqual(6);
    const what = DELIVERABLES.map((d) => d.what).join(" ").toLowerCase();
    expect(what).toMatch(/curriculum/);
    expect(what).toMatch(/facilitator/);
    expect(what).toMatch(/measurement/);
  });

  it("configures per client rather than per product", () => {
    expect(CONFIGURATION.length).toBeGreaterThanOrEqual(6);
    expect(CONFIGURATION.map((c) => c.setting).join(" ")).toMatch(/cadence/i);
  });

  it("reuses what is already built", () => {
    const have = REUSED.map((r) => r.have).join(" ");
    expect(have).toMatch(/audit/i);
    expect(have).toMatch(/redaction/i);
  });
});

describe("what is not known", () => {
  /* A page that quoted a price for a course whose audience is unknown would be
     inventing the expensive half. */
  it("asks who the client is before anything is estimated", () => {
    const all = OPEN_QUESTIONS.map((q) => `${q.question} ${q.why}`).join(" ");
    expect(all).toMatch(/who is the client/i);
    expect(all).toMatch(/contract/i);
    expect(all).toMatch(/facilitat/i);
  });

  it("explains why each is open rather than just listing it", () => {
    for (const q of OPEN_QUESTIONS) expect(q.why.length).toBeGreaterThan(60);
  });
});
