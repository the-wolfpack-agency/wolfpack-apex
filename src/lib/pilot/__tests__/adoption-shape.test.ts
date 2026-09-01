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

/**
 * A BARE STRING OF DIGITS IS NOT SOMEBODY STRUGGLING.
 *
 * Reported from the live dashboard 2026-08-29. The repeated-failures panel,
 * under the heading "somebody who kept trying, and none of them arrived as a
 * complaint", was showing:
 *
 *   36x find coaching calls spreasheet     <- real
 *   20x 6601354223758494                   <- an operator testing card handling
 *   19x 9142133456                         <- the same
 *   17x 1453674323456767                   <- the same
 *   13x wolfpackxpcna                      <- real
 *
 * Three of the five were an operator checking whether the product rejects a
 * card-shaped number, rendered on a client-facing page as user demand that
 * does not exist.
 *
 * The panel's entire value is that it is believable: it is the section a
 * competitor will not show. One fabricated-looking row costs more credibility
 * than the real rows earn, so the filter belongs in the query rather than in
 * somebody's judgment at demo time.
 */
describe("the repeated-failures panel shows questions, not keystrokes", () => {
  /** The predicate the SQL applies: at least two letters. */
  function looksLikeAQuestion(q: string): boolean {
    return /[a-z]/i.test(q) && q.replace(/[^a-z]/gi, "").length >= 2;
  }

  it.each([
    "6601354223758494",
    "9142133456",
    "1453674323456767",
    "111111111111111111",
    "4111 1111 1111 1111",
    "   ",
  ])("excludes %j, which nobody asked as a question", (noise) => {
    expect(looksLikeAQuestion(noise)).toBe(false);
  });

  it.each([
    "find coaching calls spreasheet",
    "wolfpackxpcna",
    "what does the sow say about payment terms",
    "what's our mrr",
    /* A real question that happens to contain a number must survive: the rule
       is "has words", not "has no digits". */
    "what does the 2026 sow say about payment terms",
    "who is on team 4",
  ])("keeps %j, which somebody genuinely asked", (question) => {
    expect(looksLikeAQuestion(question)).toBe(true);
  });
});
