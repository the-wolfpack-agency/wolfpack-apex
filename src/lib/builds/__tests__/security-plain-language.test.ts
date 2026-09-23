/**
 * A sample arguing we can make a whole workforce fluent had better not fabricate
 * the shape of that fluency. The checkable structure is pinned here: every
 * product carries all four plain-language beats, the method is the four beats,
 * and the certification is a real ladder.
 */
import {
  CERT_PREMISE,
  CERT_TIERS,
  GATEKEEPING,
  HEADLINE,
  METHOD,
  PRECISION_NOTE,
  ACQUISITIONS,
  DEEP_DIVES,
  PRODUCTS,
  REUSES,
  TO_BUILD_OUT,
  WHY_IT_WORKS,
  PRACTITIONER_PLAYS,
  AMBASSADOR_DRILL,
  MEETING_BRIEF,
  DEMO_PATH,
} from "@/lib/builds/security-plain-language";

describe("the method", () => {
  it("is exactly the four beats, each with a plain description", () => {
    expect(METHOD.map((m) => m.beat)).toEqual([
      "Name the jargon",
      "Say what is happening",
      "What it stops",
      "What happens without it",
    ]);
    for (const m of METHOD) expect(m.does.trim()).not.toBe("");
  });
});

describe("the products", () => {
  it("covers the breadth of the line and carries all four beats for each", () => {
    expect(PRODUCTS.length).toBeGreaterThanOrEqual(6);
    for (const p of PRODUCTS) {
      for (const field of [p.name, p.jargon, p.plain, p.stops, p.without]) {
        expect(field.trim()).not.toBe("");
      }
    }
  });
  it("stays plain: no product's explanation is left as a bare acronym", () => {
    for (const p of PRODUCTS) {
      // the plain explanation should be a sentence, not a restatement of the jargon
      expect(p.plain.length).toBeGreaterThan(60);
    }
  });
});

describe("the feature-level deep dives", () => {
  it("covers more than one flagship, including Cortex XSIAM, each feature carrying all four beats", () => {
    expect(DEEP_DIVES.length).toBeGreaterThanOrEqual(2);
    expect(DEEP_DIVES.map((d) => d.product)).toContain("Cortex XSIAM");
    for (const dive of DEEP_DIVES) {
      expect(dive.what.trim().length).toBeGreaterThan(20);
      expect(dive.features.length).toBeGreaterThanOrEqual(4);
      for (const f of dive.features) {
        for (const field of [f.name, f.jargon, f.plain, f.stops, f.without]) expect(field.trim()).not.toBe("");
        expect(f.plain.length).toBeGreaterThan(60);
      }
    }
  });
});

describe("the acquisitions coverage", () => {
  it("de-jargons the recent acquisitions, each with all four beats", () => {
    expect(ACQUISITIONS.length).toBeGreaterThanOrEqual(3);
    for (const a of ACQUISITIONS) {
      for (const field of [a.name, a.brought, a.plain, a.stops, a.without]) expect(field.trim()).not.toBe("");
    }
  });
});

describe("the certification", () => {
  it("is a ladder covering non-technical roles, each tier proving a capability", () => {
    expect(CERT_TIERS.map((t) => t.tier)).toEqual(["Foundations", "Practitioner", "Ambassador"]);
    for (const t of CERT_TIERS) {
      expect(t.who.trim()).not.toBe("");
      expect(t.proves.trim()).not.toBe("");
    }
  });
});

describe("the gatekeeping thesis", () => {
  it("names the trap and the cost", () => {
    expect(GATEKEEPING.thesis.trim().length).toBeGreaterThan(20);
    expect(GATEKEEPING.points.length).toBeGreaterThanOrEqual(3);
    for (const p of GATEKEEPING.points) expect(p.trim()).not.toBe("");
    expect(GATEKEEPING.cost.trim().length).toBeGreaterThan(20);
  });
});

describe("honesty and reuse", () => {
  it("names what it reuses", () => {
    expect(REUSES.length).toBeGreaterThanOrEqual(3);
    for (const r of REUSES) {
      expect(r.have.trim()).not.toBe("");
      expect(r.serves.trim()).not.toBe("");
    }
  });
  it("keeps the framing constants present", () => {
    for (const s of [HEADLINE, CERT_PREMISE, PRECISION_NOTE]) expect(s.trim().length).toBeGreaterThan(20);
    expect(WHY_IT_WORKS.length).toBeGreaterThanOrEqual(2);
    expect(TO_BUILD_OUT.length).toBeGreaterThanOrEqual(2);
  });

  it("covers the deep dives sellers get lost in", () => {
    const products = DEEP_DIVES.map((d) => d.product);
    for (const p of ["Cortex XSIAM", "Prisma AIRS", "Prisma Cloud", "Cortex XDR"]) expect(products).toContain(p);
  });

  it("carries Practitioner plays with a problem, product, objection and plain answer", () => {
    expect(PRACTITIONER_PLAYS.length).toBeGreaterThanOrEqual(3);
    for (const p of PRACTITIONER_PLAYS) {
      for (const field of [p.problem, p.product, p.say, p.objection, p.answer]) expect(field.trim()).not.toBe("");
      expect(p.answer.length).toBeGreaterThan(40);
    }
  });

  it("carries Ambassador habits that keep the fluency current", () => {
    expect(AMBASSADOR_DRILL.intro.trim().length).toBeGreaterThan(20);
    expect(AMBASSADOR_DRILL.drills.length).toBeGreaterThanOrEqual(3);
    for (const d of AMBASSADOR_DRILL.drills) {
      expect(d.habit.trim()).not.toBe("");
      expect(d.how.trim()).not.toBe("");
    }
  });

  it("carries a meeting brief and an ordered demo path for the presenter", () => {
    for (const s of [MEETING_BRIEF.context, MEETING_BRIEF.openBy, MEETING_BRIEF.demoMoment, MEETING_BRIEF.theHonestLine, MEETING_BRIEF.theAsk]) expect(s.trim().length).toBeGreaterThan(20);
    expect(MEETING_BRIEF.landThese.length).toBeGreaterThanOrEqual(3);
    expect(DEMO_PATH.length).toBeGreaterThanOrEqual(3);
    for (const d of DEMO_PATH) for (const field of [d.step, d.show, d.why]) expect(field.trim()).not.toBe("");
  });
});
