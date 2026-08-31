/**
 * Telling a habit from a burst.
 *
 * One document appeared to have answered 754 questions. Excluding the
 * self-identifying harnesses left 710, so it looked real. Then 609 of those
 * turned out to be two identities on two days: automated runs that had been
 * issued account ids, so nothing about WHO was asking could tell them from
 * people. What tells them apart is that they all happened at once.
 */
import {
  readSustained,
  describeSustained,
  MIN_ACTORS_FOR_A_HABIT,
  type UsageRow,
} from "../sustained";

const use = (actor: string, day: string, times: number): UsageRow[] =>
  Array.from({ length: times }, () => ({ actor, day }));

describe("a habit", () => {
  it("is several people returning across many days", () => {
    const rows = [
      ...use("a", "2026-08-01", 8),
      ...use("b", "2026-08-04", 7),
      ...use("c", "2026-08-08", 6),
      ...use("a", "2026-08-12", 5),
      ...use("d", "2026-08-19", 6),
      ...use("b", "2026-08-25", 5),
    ];
    const r = readSustained(rows);
    expect(r.isSustained).toBe(true);
    expect(describeSustained("The SOW", r)).toMatch(/losing it would be felt/i);
  });
});

describe("a burst", () => {
  /* THE ACTUAL SHAPE OF THE 754. Two identities, two days. */
  it("is not a habit however large the total", () => {
    const rows = [
      ...use("dca101a9", "2026-08-29", 216),
      ...use("0b8b89d2", "2026-08-30", 196),
      ...use("0b8b89d2", "2026-08-29", 127),
      ...use("dca101a9", "2026-08-30", 70),
      ...use("165139f0", "2026-07-31", 14),
    ];
    const r = readSustained(rows);
    expect(r.total).toBe(623);
    expect(r.isSustained).toBe(false);
  });

  /* A number describing one afternoon must not be offered as a description of
     a team, and the sentence has to say which it is. */
  it("names it as an event and offers the sustained figure instead", () => {
    const rows = [...use("one", "2026-08-29", 90), ...use("two", "2026-08-30", 10)];
    const text = describeSustained("The work order", readSustained(rows));
    expect(text).toMatch(/event rather than a habit/i);
    expect(text).toMatch(/migration, an audit/i);
    expect(text).toMatch(/Sustained use is nearer/);
    /* Says WHEN the weight fell, which is the discriminator. */
    expect(text).toMatch(/fell inside \d+ day\(s\) of a \d+-day span/);
  });

  it("refuses to call one busy person a habit", () => {
    const rows = use("one", "2026-08-29", 500);
    const r = readSustained(rows);
    expect(r.actors).toBeLessThan(MIN_ACTORS_FOR_A_HABIT);
    expect(r.isSustained).toBe(false);
  });

  /* Spread over many days but by one person is still not a team relying on
     something. */
  it("refuses a single person spread thinly", () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({ actor: "one", day: `2026-08-${i + 1}` }));
    expect(readSustained(rows).isSustained).toBe(false);
  });
});

describe("what it says when there is nothing", () => {
  it("says never used rather than implying anything", () => {
    expect(describeSustained("A document", readSustained([]))).toMatch(/never used/);
  });
});

/**
 * The case the first version passed and should not have.
 *
 * On the document that motivated this, the single busiest sitting held thirty
 * per cent, so a single-peak rule called it a habit. The top two held
 * fifty-eight and four held eighty-six.
 */
describe("several sittings, not one outlier", () => {
  it("catches use concentrated in a few sittings rather than one", () => {
    const rows = [
      ...use("dca101a9", "2026-08-29", 216),
      ...use("0b8b89d2", "2026-08-30", 196),
      ...use("0b8b89d2", "2026-08-29", 127),
      ...use("dca101a9", "2026-08-30", 70),
      ...Array.from({ length: 16 }, (_, i) => ({ actor: `p${i % 5}`, day: `2026-07-${i + 1}` })),
    ];
    const r = readSustained(rows);
    /* Five people over twenty days, and still not a habit, because half the
       use is two sittings. */
    expect(r.actors).toBeGreaterThanOrEqual(MIN_ACTORS_FOR_A_HABIT);
    expect(r.heavySpanDays).toBeLessThanOrEqual(3);
    expect(r.isSustained).toBe(false);
  });

  it("still calls evenly spread use a habit", () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({
      actor: `p${i % 5}`,
      day: `2026-08-${(i % 20) + 1}`,
    }));
    expect(readSustained(rows).isSustained).toBe(true);
  });
});
