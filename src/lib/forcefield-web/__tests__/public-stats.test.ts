/** @jest-environment node */
/**
 * Public Forcefield stats: the SAFE aggregate for the marketing page. Pins that
 * it reports only counts (never anything identifying), derives hostile correctly,
 * and never throws (a public page must degrade to zeros, not a 500).
 */
import { getPublicForcefieldStats, type StatsQuery } from "../public-stats";

const countsRow = { agents: "19933", welcomed: "1236", trapped: "49", probed: "861", payloads: "134", sites: "4" };
const attackRows = [{ attack: "path_traversal", n: "60" }, { attack: "xss", n: "16" }];

const okQuery: StatsQuery = async (sql: string) =>
  (/FILTER/.test(sql) ? [countsRow] : attackRows) as never;

describe("getPublicForcefieldStats", () => {
  it("reports the safe headline counts and derives hostile = probed + payloads + trapped", async () => {
    const s = await getPublicForcefieldStats(30, okQuery);
    expect(s.agentsDetected).toBe(19933);
    expect(s.welcomed).toBe(1236);
    expect(s.trapped).toBe(49);
    expect(s.hostile).toBe(861 + 134 + 49);
    expect(s.sitesProtected).toBe(4);
    expect(s.attacks).toEqual([{ attack: "path_traversal", count: 60 }, { attack: "xss", count: 16 }]);
  });

  it("exposes ONLY count fields - no path, operator, ip, or other identifying data", async () => {
    const s = await getPublicForcefieldStats(30, okQuery);
    const keys = new Set(Object.keys(s));
    for (const forbidden of ["path", "operator", "operatorKey", "ip", "country", "fingerprint", "props", "journeys"]) {
      expect(keys.has(forbidden)).toBe(false);
    }
  });

  it("never throws: a DB error degrades to a zeroed shape, not a 500", async () => {
    const boom: StatsQuery = async () => { throw new Error("db down"); };
    const s = await getPublicForcefieldStats(30, boom);
    expect(s.agentsDetected).toBe(0);
    expect(s.hostile).toBe(0);
    expect(s.attacks).toEqual([]);
  });
});
