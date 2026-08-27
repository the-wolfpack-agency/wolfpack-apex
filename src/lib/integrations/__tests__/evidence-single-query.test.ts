/**
 * One grouped scan, not a query per surface, and not sixty patterns per row.
 *
 * WHAT THIS COSTS WHEN IT REGRESSES. gatherEvidence began as a query per
 * surface inside a for-loop: twenty-one sequential round trips. Invisible in a
 * script that runs once. Then /playbook started rendering these figures on
 * every request and the page took NINE SECONDS to navigate to, against a tenth
 * of a second for every other page in the product. The left-nav link gives no
 * feedback while it waits, so it was reported as "the Client Playbook button
 * does not function on click, nothing happens" — which is exactly what a
 * nine-second silent navigation looks like.
 *
 * Collapsing the loop into ONE query with twenty-one FILTER clauses removed
 * the round trips and was still nine seconds, because round trips were never
 * the cost: instinct_events holds 1.9 million rows over ninety days and each
 * surface carries two or three ILIKE patterns, so roughly sixty comparisons
 * ran against every row. Grouping by event_type first (343 distinct values)
 * moved the matching into memory: 9,438ms to 966ms, same answer.
 *
 * Latency that is invisible in a script is a defect the moment a page awaits
 * it. This pins the shape so neither version comes back.
 */

const mockQuery = jest.fn();
jest.mock("@/lib/db", () => ({ query: (...a: unknown[]) => mockQuery(...a) }));

import { gatherEvidence, SURFACES, verdict } from "@/lib/integrations/evidence";

beforeEach(() => {
  jest.clearAllMocks();
  mockQuery.mockResolvedValue({
    rows: [
      { event_type: "microsoft.email_fetched", n: "51764", last: "2026-08-27" },
      { event_type: "calendar.event_created", n: "120", last: "2026-08-26" },
      { event_type: "ms_chats.listed", n: "22990", last: "2026-08-01" },
      { event_type: "something.unmatched", n: "9", last: "2026-08-27" },
    ],
  });
});

describe("the query shape", () => {
  it("asks the database exactly once, however many surfaces there are", async () => {
    /* THE REGRESSION GUARD. Twenty-one round trips is the version that made
       the page unusable, and it looks perfectly reasonable in a diff. */
    await gatherEvidence(90);
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(SURFACES.length).toBeGreaterThan(10);
  });

  it("groups by event_type rather than filtering per surface in SQL", async () => {
    /* The second version was also one query and still nine seconds, because it
       ran ~60 ILIKE comparisons against 1.9M rows. Matching belongs in memory,
       over the few hundred distinct types. */
    await gatherEvidence(90);
    const sql = String(mockQuery.mock.calls[0][0]);
    expect(sql).toMatch(/GROUP BY event_type/i);
    expect(sql).not.toMatch(/ILIKE/i);
  });

  it("binds the window rather than interpolating it", async () => {
    await gatherEvidence(30);
    expect(mockQuery.mock.calls[0][1]).toEqual([30]);
  });
});

describe("the answer is unchanged", () => {
  it("attributes each event type to the surface whose pattern matches", async () => {
    const ev = await gatherEvidence(90);
    const byLabel = Object.fromEntries(ev.map((e) => [e.label, e.events]));
    expect(byLabel["Mail"]).toBe(51764);
    expect(byLabel["Teams chat"]).toBe(22990);
  });

  it("counts a surface nothing matched as zero, and calls it unproven", async () => {
    const ev = await gatherEvidence(90);
    const unproven = ev.filter((e) => verdict(e) === "unproven");
    expect(unproven.length).toBeGreaterThan(0);
    for (const u of unproven) {
      expect(u.events).toBe(0);
      expect(u.lastSeen).toBeNull();
    }
  });

  it("takes the most recent date across every type a surface matches", async () => {
    /* A surface matching several event types must report the newest, or a
       live integration reads as stale because one of its events is old. */
    mockQuery.mockResolvedValue({
      rows: [
        { event_type: "calendar.a", n: "1", last: "2026-01-01" },
        { event_type: "calendar.b", n: "1", last: "2026-08-27" },
      ],
    });
    const cal = (await gatherEvidence(90)).find((e) => e.label === "Calendar");
    expect(cal?.lastSeen).toBe("2026-08-27");
    expect(cal?.events).toBe(2);
  });

  it("survives an empty window without inventing a surface", async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    const ev = await gatherEvidence(90);
    expect(ev).toHaveLength(SURFACES.length);
    expect(ev.every((e) => e.events === 0)).toBe(true);
  });
});
