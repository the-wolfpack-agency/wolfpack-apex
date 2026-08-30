/**
 * The whole chain, from walking a system to the section a client reads.
 *
 * WHY THIS TEST IS THE POINT. Every part of this pipeline had tests and the
 * pipeline did not exist. explore.ts, click-policy.ts and types.ts were
 * referenced only by their own tests for weeks. walkSystem wrote nothing.
 * genSystemMap read from a store nothing had ever written to, and reported "no
 * system profile has been generated" while systems were being walked.
 *
 * Unit tests cannot catch a missing connection: each end passes on its own,
 * which is exactly how the gap survived. This walks a system shaped like the
 * real tenant, infers what it manages, stores it, and renders the report, with
 * only the database faked.
 */
const mockWrite = jest.fn();
const mockSafe = jest.fn();
jest.mock("@/lib/db", () => ({
  writeQuery: (...a: unknown[]) => mockWrite(...a),
  safeQuery: (...a: unknown[]) => mockSafe(...a),
}));
const mockListSystemProfiles = jest.fn();
jest.mock("@/lib/platform-scan/profile/store", () => ({
  listSystemProfiles: (...a: unknown[]) => mockListSystemProfiles(...a),
}));

import { walkSystem, type ReadSurface } from "../walk";
import { inferEntities } from "../entities";
import { buildSystemMap } from "../explore";
import { saveWalkedMap, listWalkedMaps } from "../store";
import { genSystemMap } from "@/lib/report-sections-engagement";

const BASE = "https://forms.example";
/* Named from the real tenant, including the two that differ only by a prefix,
   because that is where a naive grouping would fold two objects into one. */
const FORMS = [
  "porschecrm", "pcnausers", "changemanagementplan", "testchangemanagementplan",
  "porschecentersusa", "brandambassadorchangemanagementplan", "invoiceandw9collection",
];

/* Cognito lays its screens out with tables, so every table on the estate has
   numbered columns and none of them is data. */
const LAYOUT_TABLE = { caption: null, columns: ["1", "2", "3", "4"], rowCount: 8 };
/* On every screen, so it is furniture. */
const HEADER_SEARCH = { name: "search", method: "get", fields: [{ name: "q", type: "text", required: false }], mutating: false };

function cognitoLike(): Record<string, Partial<ReadSurface>> {
  const pages: Record<string, Partial<ReadSurface>> = {
    [`${BASE}/acme/home`]: {
      links: FORMS.map((f) => `${BASE}/acme/${f}/all-entries`),
      forms: [HEADER_SEARCH],
      tables: [LAYOUT_TABLE],
    },
  };
  for (const f of FORMS) {
    pages[`${BASE}/acme/${f}/all-entries`] = {
      links: ["build", "publish", "entries"].map((s) => `${BASE}/acme/${f}/${s}`),
      forms: [HEADER_SEARCH],
      tables: [LAYOUT_TABLE],
    };
    pages[`${BASE}/acme/${f}/build`] = {
      forms: [
        HEADER_SEARCH,
        {
          name: f,
          method: "post",
          fields: [
            { name: "fullName", type: "text", required: true },
            { name: "emailAddress", type: "email", required: true },
            { name: "centerNumber", type: "text", required: false },
          ],
          mutating: true,
        },
      ],
    };
    pages[`${BASE}/acme/${f}/publish`] = { forms: [HEADER_SEARCH] };
    pages[`${BASE}/acme/${f}/entries`] = { forms: [HEADER_SEARCH], tables: [LAYOUT_TABLE] };
  }
  return pages;
}

/* Traffic the fake system emits per screen: an analytics beacon everywhere,
   and one host only the export screen talks to, which is the shape that makes
   per-screen attribution worth having. */
const TRAFFIC: Record<string, string[]> = {
  "*": ["https://www.google-analytics.com/collect"],
  [`${BASE}/acme/porschecrm/entries`]: ["https://telemetry.unknown.example/ingest"],
};

const readerFor = (pages: Record<string, Partial<ReadSurface>>) => ({
  observed: [] as { url: string; pageUrl: string; resourceType: string; atMs: number; status: number | null }[],
  observations() {
    return this.observed;
  },
  async read(url: string): Promise<ReadSurface> {
    const p = pages[url];
    if (!p) throw new Error(`no such page: ${url}`);
    for (const t of [...TRAFFIC["*"], ...(TRAFFIC[url] ?? [])]) {
      this.observed.push({ url: t, pageUrl: url, resourceType: "fetch", atMs: 1, status: 200 });
    }
    return {
      url, status: 200, title: null, headings: [], links: [],
      forms: [], tables: [], controls: [], loadMs: 120, ...p,
    };
  },
});

async function walkAndStore() {
  const { surfaces, coverage, integrations, trafficObserved } = await walkSystem(
    `${BASE}/acme/home`,
    readerFor(cognitoLike()),
    { budget: { maxSurfaces: 40, maxDepth: 6, maxDurationMs: 60_000 } },
  );
  const entities = inferEntities(surfaces, coverage.patterns);
  const map = buildSystemMap({
    platform: "forms.example",
    entryUrl: `${BASE}/acme/home`,
    surfaces,
    entities,
    integrations,
    coverage,
    now: "2026-08-30T00:00:00.000Z",
  });
  await saveWalkedMap("ws-1", map, "CTO, Acme");
  return { surfaces, coverage, entities, map, integrations, trafficObserved };
}

beforeEach(() => {
  mockWrite.mockReset().mockResolvedValue({ rows: [] });
  mockSafe.mockReset().mockResolvedValue({ rows: [] });
  mockListSystemProfiles.mockReset().mockResolvedValue([]);
});

describe("walking a system shaped like the real tenant", () => {
  it("opens every business object without walking every screen", async () => {
    const { surfaces } = await walkAndStore();
    /* 1 home + 7 forms x 4 screens = 29 if it opened everything. */
    expect(surfaces.length).toBeLessThan(29);
    const opened = new Set(surfaces.map((s) => new URL(s.url).pathname.split("/")[2]));
    for (const f of FORMS) expect(opened.has(f)).toBe(true);
  });

  it("finds every form as a business object", async () => {
    const { entities } = await walkAndStore();
    const names = entities.map((e) => e.name);
    for (const f of FORMS) expect(names).toContain(f);
  });

  /* Two objects whose names share a prefix must stay two objects. */
  it("keeps objects apart whose names contain one another", async () => {
    const { entities } = await walkAndStore();
    const names = entities.map((e) => e.name);
    expect(names).toContain("changemanagementplan");
    expect(names).toContain("testchangemanagementplan");
    expect(names).toContain("brandambassadorchangemanagementplan");
  });

  it("takes attributes from the forms and nothing from the layout tables", async () => {
    const { entities } = await walkAndStore();
    const crm = entities.find((e) => e.name === "porschecrm")!;
    expect(crm.attributes).toEqual(["centerNumber", "emailAddress", "fullName"]);
    const all = entities.flatMap((e) => e.attributes);
    for (const c of ["1", "2", "3", "4"]) expect(all).not.toContain(c);
    /* The header search box is on every screen and belongs to no object. */
    expect(all).not.toContain("q");
  });

  it("does not report the tenant as one of its own objects", async () => {
    const { entities } = await walkAndStore();
    expect(entities.map((e) => e.name)).not.toContain("acme");
  });
});

describe("from the walk to the client-facing section", () => {
  /* THE CONNECTION THAT DID NOT EXIST. Both ends passed their own tests while
     nothing joined them. */
  it("renders the walked system in the report", async () => {
    const { map } = await walkAndStore();
    /* What saveWalkedMap wrote is what listWalkedMaps reads back. */
    const p = mockWrite.mock.calls[0][1] as unknown[];
    mockSafe.mockResolvedValue({
      rows: [
        {
          platform: p[1], entry_url: p[2], map: p[3],
          surface_count: p[4], entity_count: p[5], form_count: p[6],
          frontier_remaining: p[7], stop_reason: p[8], authorised_by: p[9],
          generated_at: new Date("2026-08-30T00:00:00.000Z"),
        },
      ],
    });

    const stored = await listWalkedMaps("ws-1");
    expect(stored[0].map.entities).toHaveLength(map.entities.length);

    const md = await genSystemMap({ clientName: "Acme", workspaceId: "ws-1" });
    expect(md).toContain("forms.example");
    expect(md).toContain("porschecrm");
    expect(md).toContain("emailAddress");
    expect(md).toMatch(/walked, not read/i);
    expect(md).toContain("CTO, Acme");
    /* The section that used to be printed no matter what had been walked. */
    expect(md).not.toContain("No system profile has been generated");
  });

  /* Sampled is not found, all the way through to the client's document. */
  it("carries the sampling caveat into the report", async () => {
    await walkAndStore();
    const p = mockWrite.mock.calls[0][1] as unknown[];
    mockSafe.mockResolvedValue({
      rows: [
        {
          platform: p[1], entry_url: p[2], map: p[3],
          surface_count: p[4], entity_count: p[5], form_count: p[6],
          frontier_remaining: p[7], stop_reason: p[8], authorised_by: p[9],
          generated_at: new Date("2026-08-30T00:00:00.000Z"),
        },
      ],
    });
    const md = await genSystemMap({ clientName: "Acme", workspaceId: "ws-1" });
    expect(md).toMatch(/sampled, not walked/i);
  });
});

/**
 * Where the data goes, carried from the browser to the client's document.
 *
 * The observation classifier and the anomaly detectors were written, tested
 * and fed by exactly one single-page collector. The walker, which sees dozens
 * of screens, threw every request away.
 */
describe("watching where the data goes", () => {
  it("reports that it was watching, which is not the same as seeing nothing", async () => {
    const { trafficObserved } = await walkAndStore();
    expect(trafficObserved).toBe(true);
  });

  it("names the vendor it recognises", async () => {
    const { integrations } = await walkAndStore();
    expect(integrations.find((i) => i.vendor === "Google Analytics")).toBeTruthy();
  });

  /* PER SCREEN, which is the reason to walk rather than load one page. A host
     contacted only by the entries screen is invisible from the home page. */
  it("finds a host only one screen talks to, and says which", async () => {
    const { integrations } = await walkAndStore();
    const only = integrations.find((i) => i.host === "telemetry.unknown.example")!;
    expect(only.vendor).toBeNull();
    expect(only.seenOn).toEqual([`${BASE}/acme/porschecrm/entries`]);
  });

  it("does not count the system's own screens as outside services", async () => {
    const { integrations } = await walkAndStore();
    expect(integrations.map((i) => i.host)).not.toContain("forms.example");
  });

  it("carries the services into the report a client reads", async () => {
    await walkAndStore();
    const p = mockWrite.mock.calls[0][1] as unknown[];
    mockSafe.mockResolvedValue({
      rows: [
        {
          platform: p[1], entry_url: p[2], map: p[3],
          surface_count: p[4], entity_count: p[5], form_count: p[6],
          frontier_remaining: p[7], stop_reason: p[8], authorised_by: p[9],
          generated_at: new Date("2026-08-30T00:00:00.000Z"),
        },
      ],
    });
    const md = await genSystemMap({ clientName: "Acme", workspaceId: "ws-1" });
    expect(md).toContain("Outside services contacted");
    expect(md).toContain("Google Analytics");
    expect(md).toContain("telemetry.unknown.example");
  });
});
