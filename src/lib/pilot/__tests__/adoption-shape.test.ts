/**
 * Who is actually using this, and who quietly stopped.
 *
 * A pilot is judged on adoption, and adoption is the one thing the existing
 * pilot figures cannot show. Passages indexed and answers given describe the
 * product working. They say nothing about whether the people it was bought for
 * have taken it up, and a pilot can post good numbers while most of the team
 * never opened it.
 */
import {
  adoptionVerdict,
  reachedShare,
  neverStarted,
  type AdoptionSnapshot,
} from "@/lib/pilot/adoption-shape";

const snap = (over: Partial<AdoptionSnapshot> = {}): AdoptionSnapshot => ({
  invited: 10,
  everAsked: 6,
  activeRecently: 4,
  lapsed: 1,
  unansweredQuestions: 0,
  repeatedFailures: [],
  readable: true,
  ...over,
});

describe("unreadable is not zero", () => {
  /* A pilot review is the worst place to confuse "nobody used it" with "we
     could not tell". They lead to opposite decisions. */
  it("reports unknown rather than a verdict it cannot support", () => {
    expect(adoptionVerdict(snap({ readable: false }))).toBe("unknown");
  });

  it("refuses to compute a share it could not read", () => {
    expect(reachedShare(snap({ readable: false }))).toBeNull();
    expect(neverStarted(snap({ readable: false }))).toBeNull();
  });

  /* Zero out of zero is not a reach of nought per cent, it is a pilot that has
     not started. */
  it("refuses a share when nobody was invited", () => {
    expect(reachedShare(snap({ invited: 0, everAsked: 0 }))).toBeNull();
  });
});

describe("the reading", () => {
  it("says nothing has started when nobody has asked", () => {
    expect(adoptionVerdict(snap({ everAsked: 0, activeRecently: 0, lapsed: 0 }))).toBe(
      "not_started",
    );
  });

  /* The direction matters more than the total. More people drifting away than
     using it is a failing pilot even when the headline looks healthy. */
  it("calls it slipping when more have lapsed than are active", () => {
    expect(adoptionVerdict(snap({ everAsked: 8, activeRecently: 2, lapsed: 5 }))).toBe(
      "slipping",
    );
  });

  it("calls it narrow when most of the team never started", () => {
    expect(adoptionVerdict(snap({ invited: 20, everAsked: 4, activeRecently: 4, lapsed: 0 }))).toBe(
      "narrow",
    );
  });

  it("calls it taking hold when most have tried it and few have drifted", () => {
    expect(adoptionVerdict(snap())).toBe("taking_hold");
  });
});

describe("the numbers a pilot most needs", () => {
  it("counts the people who never started", () => {
    expect(neverStarted(snap({ invited: 10, everAsked: 6 }))).toBe(4);
  });

  /* A share above 100 per cent on a client dashboard is worse than no share at
     all, and the first version produced one by counting askers and invitees
     from different populations. */
  it("never reports more askers than people", () => {
    const share = reachedShare(snap({ invited: 10, everAsked: 13 }));
    expect(share).not.toBeNull();
    expect(neverStarted(snap({ invited: 10, everAsked: 13 }))).toBe(0);
  });

  it("computes the reach as a plain share", () => {
    expect(reachedShare(snap({ invited: 10, everAsked: 6 }))).toBeCloseTo(0.6);
  });
});
