/** @jest-environment node */
/**
 * Incident grouping (one incident per source burst, every class together),
 * routing, exact aggregation, and the digest period math (US Eastern, DST,
 * window-aligned partition, rollover after a missed digest).
 */
import {
  buildIncidents,
  buildDigest,
  digestCutoff,
  digestPeriod,
  digestResumeFrom,
  easternParts,
  previousEasternDate,
  attentionReasons,
  incidentIdentity,
  BURST_GAP_SECONDS,
  type HostileEventGroup,
} from "../incidents";

function g(over: Partial<HostileEventGroup> = {}): HostileEventGroup {
  const firstAt = over.firstAt ?? "2026-10-26T14:02:44.000Z";
  return {
    kind: "payload_attack", site: "instinct", attackClass: "sql_injection", windowStart: "2026-10-26T12:00:00.000Z",
    fp: "", sig: "", path: "/", country: "US", hosting: "residential", clientType: "unknown", agent: "unidentified", network: "",
    outcome: "blocked", posture: "enforce", reasonKind: "payload", count: 1, firstAt, lastAt: over.lastAt ?? firstAt, ...over,
  };
}
const at = (s: number) => new Date(Date.parse("2026-10-26T14:00:00.000Z") + s * 1000).toISOString();

describe("grouping", () => {
  it("a header-rotating scanner (new fingerprint and signature per request) is one burst", () => {
    const burst = Array.from({ length: 10 }, (_, i) => g({ fp: `fp${i}`, sig: `s${i}`, attackClass: i % 2 ? "xss" : "ssrf", firstAt: at(i) }));
    const inc = buildIncidents(burst);
    expect(inc).toHaveLength(1);
    expect(inc[0].classes.map((c) => [c.attackClass, c.count])).toEqual([["ssrf", 5], ["xss", 5]]);
  });

  it("activity further apart than the burst gap, from different sources, is separate", () => {
    const inc = buildIncidents([g({ fp: "a", firstAt: at(0) }), g({ fp: "b", firstAt: at(BURST_GAP_SECONDS + 1) })]);
    expect(inc).toHaveLength(2);
  });

  it("the same fingerprint or signature links groups however far apart in the window", () => {
    expect(buildIncidents([g({ fp: "a", firstAt: at(0) }), g({ fp: "a", firstAt: at(3600) })])).toHaveLength(1);
    expect(buildIncidents([g({ sig: "s", firstAt: at(0) }), g({ sig: "s", firstAt: at(3600) })])).toHaveLength(1);
  });

  it("never groups across sites or windows", () => {
    expect(buildIncidents([g({ fp: "a" }), g({ fp: "a", site: "ogiam.com" })])).toHaveLength(2);
    expect(buildIncidents([g({ fp: "a" }), g({ fp: "a", windowStart: "2026-10-26T18:00:00.000Z", firstAt: "2026-10-26T18:00:01.000Z" })])).toHaveLength(2);
  });

  it("counts are exact: requests, outcomes, distinct paths and fingerprints, first/last; top paths by volume", () => {
    const [inc] = buildIncidents([
      g({ fp: "a", path: "/x", count: 5, firstAt: at(0), lastAt: at(10) }),
      g({ fp: "a", path: "/y", count: 2, firstAt: at(3), outcome: "contained" }),
      g({ fp: "b", path: "/x", count: 1, firstAt: at(4), lastAt: at(30) }),
    ]);
    expect(inc.detail).toMatchObject({ count: 8, pathCount: 2, paths: ["/x", "/y"], fingerprintCount: 2, firstAt: at(0), lastAt: at(30), outcomes: { blocked: 6, contained: 2, recorded: 0 } });
  });

  it("the anchor (dedupe identity) is stable as the burst grows", () => {
    const first = g({ fp: "a", firstAt: at(0) });
    const [a] = buildIncidents([first]);
    const [b] = buildIncidents([first, g({ fp: "z", firstAt: at(30) }), g({ fp: "a", firstAt: at(900) })]);
    expect(b.anchor).toBe(a.anchor);
  });

  it("drops empty groups", () => {
    expect(buildIncidents([g({ count: 0 })])).toEqual([]);
  });
});

describe("routing", () => {
  it("decoy -> immediate; not stopped -> immediate; blocked or contained only -> digest", () => {
    expect(attentionReasons([g({ kind: "honeytoken_trip", attackClass: "honeytoken_trip", outcome: "contained" })])).toEqual(["decoy"]);
    expect(attentionReasons([g({ outcome: "recorded" })])).toEqual(["unblocked"]);
    expect(attentionReasons([g(), g({ outcome: "contained" })])).toEqual([]);
    expect(buildIncidents([g()])[0].route).toBe("digest");
    expect(buildIncidents([g({ fp: "a" }), g({ fp: "a", outcome: "recorded", attackClass: "xss" })])[0]).toMatchObject({ route: "immediate", attention: ["unblocked"] });
  });
});

describe("digest period (US Eastern, window aligned)", () => {
  it("Eastern date and hour, DST-aware", () => {
    expect(easternParts(new Date("2026-10-27T12:05:00Z"))).toEqual({ date: "2026-10-27", hour: 8 });
    expect(easternParts(new Date("2026-11-03T12:05:00Z"))).toEqual({ date: "2026-11-03", hour: 7 });
    expect(easternParts(new Date("2026-10-27T03:59:00Z"))).toEqual({ date: "2026-10-26", hour: 23 });
  });

  it("the cutoff is the window boundary at or before 08:00 ET (EDT and EST both 12:00 UTC)", () => {
    expect(digestCutoff("2026-10-27").toISOString()).toBe("2026-10-27T12:00:00.000Z");
    expect(digestCutoff("2026-11-03").toISOString()).toBe("2026-11-03T12:00:00.000Z");
    expect(digestCutoff("2026-11-01").toISOString()).toBe("2026-11-01T12:00:00.000Z");
    expect(previousEasternDate("2026-11-01")).toBe("2026-10-31");
    expect(previousEasternDate("2027-01-01")).toBe("2026-12-31");
  });

  it("not due before 08:00 ET; due on the first scan after (EST: 13:00 UTC)", () => {
    expect(digestPeriod(new Date("2026-10-27T11:59:00Z"), null)).toBeNull();
    expect(digestPeriod(new Date("2026-11-03T12:30:00Z"), null)).toBeNull();
    const p = digestPeriod(new Date("2026-11-03T13:00:00Z"), null)!;
    expect([p.etDate, p.start.toISOString(), p.end.toISOString()]).toEqual(["2026-11-03", "2026-11-02T12:00:00.000Z", "2026-11-03T12:00:00.000Z"]);
  });

  it("resumes from an earlier handled end after a missed digest, capped at 7 days", () => {
    const now = new Date("2026-10-29T12:05:00Z");
    expect(digestPeriod(now, new Date("2026-10-27T12:00:00Z"))!.start.toISOString()).toBe("2026-10-27T12:00:00.000Z");
    expect(digestPeriod(now, new Date("2026-10-01T12:00:00Z"))!.start.toISOString()).toBe("2026-10-22T12:00:00.000Z");
    // A resume point at or after the normal start never shortens the period.
    expect(digestPeriod(now, new Date("2026-10-29T12:00:00Z"))!.start.toISOString()).toBe("2026-10-28T12:00:00.000Z");
  });

  it("digestResumeFrom: handled end first, else the start of the earliest unhandled digest", () => {
    expect(digestResumeFrom(new Date("2026-10-27T12:00:00Z"), new Date("2026-10-28T12:00:00Z"))!.toISOString()).toBe("2026-10-27T12:00:00.000Z");
    expect(digestResumeFrom(null, new Date("2026-10-28T12:00:00Z"))!.toISOString()).toBe("2026-10-27T12:00:00.000Z");
    expect(digestResumeFrom(null, null)).toBeNull();
  });
});

describe("buildDigest", () => {
  const period = { etDate: "2026-10-27", start: new Date("2026-10-26T12:00:00Z"), end: new Date("2026-10-27T12:00:00Z") };

  it("per site, blocked incidents only, exact totals; immediate ones counted separately", () => {
    const inc = buildIncidents([
      g({ fp: "a", count: 3, attackClass: "xss" }),
      g({ fp: "a", count: 2, attackClass: "sql_injection" }),
      g({ site: "ogiam.com", fp: "b", count: 1, windowStart: "2026-10-26T18:00:00.000Z", firstAt: "2026-10-26T19:00:00.000Z" }),
      g({ site: "ogiam.com", fp: "c", kind: "honeytoken_trip", attackClass: "honeytoken_trip", outcome: "contained", firstAt: "2026-10-26T13:00:00.000Z" }),
    ]);
    const d = buildDigest(inc, period);
    expect(d.totals).toEqual({ incidents: 2, attempts: 6, sites: 2, sources: 2 });
    expect(d.immediateIncidents).toBe(1);
    expect(d.sites.map((s) => [s.site, s.attempts, s.rows.map((r) => r.attackClass)])).toEqual([["instinct", 5, ["xss", "sql_injection"]], ["ogiam.com", 1, ["sql_injection"]]]);
  });

  it("only incidents whose window starts in [start, end): adjacent periods never overlap", () => {
    const inc = buildIncidents([
      g({ fp: "a", windowStart: "2026-10-26T06:00:00.000Z", firstAt: "2026-10-26T11:59:59.000Z" }),
      g({ fp: "b", windowStart: "2026-10-26T12:00:00.000Z", firstAt: "2026-10-26T12:00:00.000Z" }),
      g({ fp: "c", windowStart: "2026-10-27T12:00:00.000Z", firstAt: "2026-10-27T12:00:00.000Z" }),
    ]);
    const d = buildDigest(inc, period);
    expect(d.incidentKeys).toEqual([incidentIdentity(inc[1])]);
    const prev = buildDigest(inc, { etDate: "2026-10-26", start: new Date("2026-10-25T12:00:00Z"), end: period.start });
    expect(prev.incidentKeys).toEqual([incidentIdentity(inc[0])]);
  });

  it("empty when nothing was blocked", () => {
    expect(buildDigest([], period).totals.incidents).toBe(0);
  });
});
