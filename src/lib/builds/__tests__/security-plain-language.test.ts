/**
 * A sample arguing we can make a whole workforce fluent had better not fabricate
 * the shape of that fluency. The checkable structure is pinned here: every
 * product carries all four plain-language beats, the method is the four beats,
 * and the certification is a real ladder.
 */
import {
  CERT_PREMISE,
  CERT_TIERS,
  FDE,
  GATEKEEPING,
  HEADLINE,
  METHOD,
  PRECISION_NOTE,
  PRODUCTS,
  REUSES,
  XSIAM_DEEP,
  TO_BUILD_OUT,
  WHY_IT_WORKS,
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

describe("the flagship deep dive (Cortex XSIAM)", () => {
  it("names the flagship and carries all four beats for each feature", () => {
    expect(XSIAM_DEEP.product).toMatch(/Cortex XSIAM/i);
    expect(XSIAM_DEEP.what.trim().length).toBeGreaterThan(20);
    expect(XSIAM_DEEP.features.length).toBeGreaterThanOrEqual(5);
    for (const f of XSIAM_DEEP.features) {
      for (const field of [f.name, f.jargon, f.plain, f.stops, f.without]) expect(field.trim()).not.toBe("");
      expect(f.plain.length).toBeGreaterThan(60);
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

describe("the forward-deployed-engineer track", () => {
  it("names the role, the gap, and what the coursework covers", () => {
    expect(FDE.role).toMatch(/Forward Deployed Engineer/i);
    for (const s of [FDE.why, FDE.gap]) expect(s.trim().length).toBeGreaterThan(20);
    expect(FDE.coursework.length).toBeGreaterThanOrEqual(3);
    for (const c of FDE.coursework) {
      expect(c.covers.trim()).not.toBe("");
      expect(c.so.trim()).not.toBe("");
    }
  });
});

describe("honesty and reuse", () => {
  it("names what it reuses, including the not-transferable content", () => {
    expect(REUSES.length).toBeGreaterThanOrEqual(3);
    expect(REUSES.some((r) => /not transfer|brand-specific/i.test(r.have + r.serves))).toBe(true);
  });
  it("keeps the framing constants present", () => {
    for (const s of [HEADLINE, CERT_PREMISE, PRECISION_NOTE]) expect(s.trim().length).toBeGreaterThan(20);
    expect(WHY_IT_WORKS.length).toBeGreaterThanOrEqual(2);
    expect(TO_BUILD_OUT.length).toBeGreaterThanOrEqual(2);
  });
});
