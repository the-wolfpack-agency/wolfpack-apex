/**
 * The panel this feeds is read by a client, so the tests that matter are the
 * ones about what it refuses to claim.
 *
 * The fixture is the real eight weeks from production on 2026-08-27, not an
 * invented curve.  That history is lopsided (6, 3, 6, 20, 5, 67, then 584)
 * and every quality event in it first fired in the final week, when the checks
 * that emit them shipped. That is exactly the shape that made the old table
 * print a grid of zeros under the title "Is it getting better".
 */
import {
  summariseQuality,
  MIN_VOLUME_FOR_TREND,
  type QualityWeek,
} from "@/lib/learning/answer-quality";

const week = (over: Partial<QualityWeek> & { weekStart: string }): QualityWeek => ({
  modelCalls: 0,
  flagged: 0,
  reviewed: 0,
  corrected: 0,
  irrelevantRetrievals: 0,
  notPromoted: 0,
  ...over,
});

/** Production, read 2026-08-27. */
const REAL_HISTORY: QualityWeek[] = [
  week({ weekStart: "2026-07-06", modelCalls: 6 }),
  week({ weekStart: "2026-07-13", modelCalls: 3 }),
  week({ weekStart: "2026-07-27", modelCalls: 6 }),
  week({ weekStart: "2026-08-03", modelCalls: 20 }),
  week({ weekStart: "2026-08-10", modelCalls: 5 }),
  week({ weekStart: "2026-08-17", modelCalls: 67 }),
  week({
    weekStart: "2026-08-24",
    modelCalls: 584,
    reviewed: 31,
    corrected: 8,
    irrelevantRetrievals: 57,
    notPromoted: 40,
  }),
];

describe("summariseQuality", () => {
  describe("against the real production history", () => {
    const s = summariseQuality(REAL_HISTORY);

    /* THE HEADLINE BEHAVIOUR. Prior volume is 107 answers and the latest week
       is 584, so the window itself is comparable. Every check still fired for
       the first time in that final week, so a direction would be reporting a
       deployment date as a quality gain. */
    it("declines to call a direction when the checks are newer than the window", () => {
      expect(s.comparable).toBe(true);
      expect(s.verdict).toMatch(/No direction to report yet/);
      for (const sig of s.signals) {
        expect(["no-baseline", "flat"]).toContain(sig.trend);
      }
      expect(s.signals.filter((x) => x.trend === "no-baseline").length).toBeGreaterThan(0);
    });

    /* The check that never matched is a true zero, not a missing baseline:
       inspectResponse ran on all 584 answers and found nothing. */
    it("reads a check that ran and matched nothing as flat, not as unknown", () => {
      expect(s.signals.find((x) => x.key === "flagged")!.trend).toBe("flat");
    });

    it("still reports the real counts, because they happened", () => {
      const corrected = s.signals.find((x) => x.key === "corrected")!;
      expect(corrected.latest).toBe(8);
      const discarded = s.signals.find((x) => x.key === "irrelevantRetrievals")!;
      expect(discarded.latest).toBe(57);
    });

    it("says how much traffic sits on each side of the comparison", () => {
      expect(s.latestVolume).toBe(584);
      expect(s.priorVolume).toBe(107);
      expect(s.latestWeek).toBe("2026-08-24");
    });
  });

  /* The defect this whole change exists to fix. The router records these and
     delivers the answer; the panel called them "stopped". */
  it("classifies flagged answers as recorded, never as blocked", () => {
    const flagged = summariseQuality(REAL_HISTORY).signals.find((x) => x.key === "flagged")!;
    expect(flagged.effect).toBe("recorded");
    expect(flagged.label).not.toMatch(/stopped|blocked|prevented/i);
  });

  it("classifies model review as volume rather than as a catch", () => {
    const reviewed = summariseQuality(REAL_HISTORY).signals.find((x) => x.key === "reviewed")!;
    expect(reviewed.effect).toBe("volume");
  });

  it("marks as blocked only the three signals that change what a person reads", () => {
    const blocked = summariseQuality(REAL_HISTORY)
      .signals.filter((x) => x.effect === "blocked")
      .map((x) => x.key)
      .sort();
    expect(blocked).toEqual(["corrected", "irrelevantRetrievals", "notPromoted"]);
  });

  describe("once there is enough traffic on both sides", () => {
    const busy = (weekStart: string, calls: number, corrected: number): QualityWeek =>
      week({ weekStart, modelCalls: calls, corrected });

    it("compares rates, not counts, so a busier week is not a worse one", () => {
      /* Same rate, ten times the volume. A count comparison calls this a
         tenfold regression; a rate comparison calls it flat. */
      const s = summariseQuality([busy("w1", 200, 20), busy("w2", 2000, 200)]);
      expect(s.comparable).toBe(true);
      expect(s.signals.find((x) => x.key === "corrected")!.trend).toBe("flat");
    });

    it("reports a genuine rise as up", () => {
      const s = summariseQuality([busy("w1", 200, 2), busy("w2", 200, 40)]);
      expect(s.signals.find((x) => x.key === "corrected")!.trend).toBe("up");
    });

    it("reports a genuine fall as down", () => {
      const s = summariseQuality([busy("w1", 200, 40), busy("w2", 200, 2)]);
      expect(s.signals.find((x) => x.key === "corrected")!.trend).toBe("down");
    });

    it("does not manufacture a direction out of rounding", () => {
      const s = summariseQuality([busy("w1", 1000, 100), busy("w2", 1000, 102)]);
      expect(s.signals.find((x) => x.key === "corrected")!.trend).toBe("flat");
    });

    it("needs the floor cleared on BOTH sides", () => {
      const thin = MIN_VOLUME_FOR_TREND - 1;
      expect(summariseQuality([busy("w1", thin, 1), busy("w2", 5000, 100)]).comparable).toBe(false);
      expect(summariseQuality([busy("w1", 5000, 100), busy("w2", thin, 1)]).comparable).toBe(false);
    });
  });

  describe("degenerate windows", () => {
    it("says so rather than throwing when there are no weeks", () => {
      const s = summariseQuality([]);
      expect(s.signals).toEqual([]);
      expect(s.comparable).toBe(false);
      expect(s.verdict).toMatch(/no trend/i);
    });

    it("renders a rate of null, never zero, when nothing was checked", () => {
      const s = summariseQuality([week({ weekStart: "w1" }), week({ weekStart: "w2" })]);
      expect(s.comparable).toBe(false);
      for (const sig of s.signals) {
        expect(sig.latestRate).toBeNull();
        expect(sig.priorRate).toBeNull();
        expect(sig.trend).toBe("insufficient");
      }
    });

    /* A signal appearing for the first time must not read as a rise, which is
       how a dashboard turns "we shipped a check" into "quality improved". */
    it("calls a first-ever occurrence no-baseline rather than up", () => {
      const s = summariseQuality([
        week({ weekStart: "w1", modelCalls: 500 }),
        week({ weekStart: "w2", modelCalls: 500, corrected: 40 }),
      ]);
      expect(s.signals.find((x) => x.key === "corrected")!.trend).toBe("no-baseline");
    });

    it("carries a reading for every signal in every state", () => {
      for (const s of [summariseQuality(REAL_HISTORY), summariseQuality([week({ weekStart: "w1", modelCalls: 500 }), week({ weekStart: "w2", modelCalls: 500 })])]) {
        for (const sig of s.signals) expect(sig.reading.length).toBeGreaterThan(20);
      }
    });
  });
});
