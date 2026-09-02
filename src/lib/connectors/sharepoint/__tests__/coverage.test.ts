/** @jest-environment node */
/**
 * Knowing what we are connected to.
 *
 * Written after the question "are we connected to all the docs?" could not be
 * answered by the product at all. What was actually there on 2026-09-02: six
 * sources pointing at two SharePoint sites out of nine in the tenant, each at a
 * folder several levels down, three of the six never synced (two of those exact
 * duplicates), one named TEST, and the three live ones six days stale because
 * the Microsoft connection had silently stopped.
 *
 * Every case below is one of those, because a report that would not have caught
 * the thing that happened is decoration.
 */

import {
  readCoverage,
  describeCoverage,
  siteOf,
  STALE_AFTER_DAYS,
  type CoverageReport,
  type Queryable,
} from "../coverage";

const NOW = new Date("2026-09-02T12:00:00.000Z");
/* Every read is workspace-scoped; the guardrail refuses an unscoped one. */
const WS = "default";
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

const SITE_A = "https://tenant.sharepoint.com/sites/PCNAINTERNAL";
const SITE_B = "https://tenant.sharepoint.com/sites/WolfpackxPCNA";

function client(sources: unknown[], docs: unknown[] = []): Queryable {
  return {
    query: async <T,>(sql: string) => ({
      rows: (/instinct_sharepoint_sources/.test(sql) ? sources : docs) as T[],
    }),
  };
}

const source = (over: Record<string, unknown> = {}) => ({
  id: "s1",
  name: "PCNA Program Evals",
  site_url: `${SITE_A}/Shared%20Documents/Brand%20Ambassador/Program%20Evals`,
  folder_path: "Brand Ambassador/Program Evals",
  is_active: true,
  last_synced_at: daysAgo(0),
  ...over,
});

describe("reading which site a source belongs to", () => {
  it("takes the site, not the folder inside it", () => {
    expect(siteOf(`${SITE_A}/Shared%20Documents/Deep/Folder`)).toBe(SITE_A.toLowerCase());
  });

  /* The stored URLs include the view query string SharePoint puts on a "copy
     link", which must not become part of the site identity or one site would
     count as several. */
  it("ignores a trailing query string", () => {
    expect(siteOf(`${SITE_B}/Shared%20Documents/Forms/AllItems.aspx?id=%2Fx&viewid=abc`)).toBe(
      SITE_B.toLowerCase(),
    );
  });

  it("returns null for something that is not a site URL", () => {
    expect(siteOf("https://tenant.sharepoint.com/personal/someone")).toBeNull();
    expect(siteOf(null)).toBeNull();
  });
});

describe("what the report notices", () => {
  it("counts the sites, not the sources, because three pastes at one site is one site", async () => {
    const r = await readCoverage(
      client([source({ id: "a" }), source({ id: "b" }), source({ id: "c", site_url: SITE_B })]),
      WS,
      NOW,
    );
    expect(r.sources).toHaveLength(3);
    expect(r.sitesConnected).toHaveLength(2);
  });

  /* THE THREE THAT WERE FOUND. A source switched off, and a source that has
     never once run, both look like configuration and contribute nothing. */
  it("calls out a source that has never synced", async () => {
    const r = await readCoverage(client([source({ last_synced_at: null })]), WS, NOW);
    expect(r.dormant).toHaveLength(1);
  });

  it("calls out a source that is switched off", async () => {
    const r = await readCoverage(client([source({ is_active: false })]), WS, NOW);
    expect(r.dormant).toHaveLength(1);
  });

  /* THE ONE THAT MATTERED MOST. The three live sources were six days stale
     because the token store had been failing, and nothing anywhere said so. */
  it("calls out an active source that has stopped syncing", async () => {
    const r = await readCoverage(client([source({ last_synced_at: daysAgo(6) })]), WS, NOW);
    expect(r.stale).toHaveLength(1);
    expect(r.dormant).toHaveLength(0);
  });

  it("leaves a source that synced today alone", async () => {
    const r = await readCoverage(client([source({ last_synced_at: daysAgo(0) })]), WS, NOW);
    expect(r.stale).toEqual([]);
  });

  /* The boundary is a judgment, so it is asserted rather than left to drift. */
  it("treats the day before the cutoff as still fresh", async () => {
    const r = await readCoverage(client([source({ last_synced_at: daysAgo(STALE_AFTER_DAYS - 1) })]), WS, NOW);
    expect(r.stale).toEqual([]);
  });

  /* Content from a site no source points at still answers questions, and
     nothing refreshes it, so the answers age without anybody being told. */
  it("finds indexed content that no source refreshes", async () => {
    const r = await readCoverage(
      client([source()], [{ site: "https://tenant.sharepoint.com/sites/ogiam", total: "12", readable: "9" }]),
      WS,
      NOW,
    );
    expect(r.sitesIndexedWithoutSource).toEqual(["https://tenant.sharepoint.com/sites/ogiam"]);
  });

  it("attributes documents to the source's site", async () => {
    const r = await readCoverage(
      client([source()], [{ site: SITE_A.toLowerCase(), total: "40", readable: "31" }]),
      WS,
      NOW,
    );
    expect(r.sources[0]).toMatchObject({ documentsIndexed: 40, documentsReadable: 31 });
  });
});

describe("what it says, and what it refuses to fail on", () => {
  const report = async (sources: unknown[], docs: unknown[] = []) =>
    describeCoverage(await readCoverage(client(sources, docs), WS, NOW));

  it("is ok when every source is active and syncing", async () => {
    expect((await report([source()])).ok).toBe(true);
  });

  it("is not ok when a source has stopped", async () => {
    expect((await report([source({ last_synced_at: daysAgo(6) })])).ok).toBe(false);
  });

  /* A NARROW CONNECTION IS NOT A FAILURE. A Center may deliberately connect one
     folder, and a report that went red for that would be argued with once and
     then ignored. It is stated in the lines and never fails the run. */
  it("does not fail merely because only one folder is connected", async () => {
    const r = await report([source({ folder_path: "General/Ad-hoc Training Projects" })]);
    expect(r.ok).toBe(true);
    expect(r.lines.join("\n")).toContain("General/Ad-hoc Training Projects");
  });

  it("names the folder, so a deep connection is visible at a glance", async () => {
    const r = await report([source({ folder_path: null })]);
    expect(r.lines.join("\n")).toContain("(library root)");
  });

  it("says how much of what it holds is actually readable", async () => {
    const r = await report([source()], [{ site: SITE_A.toLowerCase(), total: "40", readable: "31" }]);
    expect(r.lines.join("\n")).toContain("31/40 readable");
  });
});

describe("the shape callers depend on", () => {
  it("returns every list even when there is nothing to report", async () => {
    const r: CoverageReport = await readCoverage(client([]), WS, NOW);
    expect(r).toMatchObject({
      sources: [],
      sitesConnected: [],
      dormant: [],
      stale: [],
      sitesIndexedWithoutSource: [],
    });
  });
});
