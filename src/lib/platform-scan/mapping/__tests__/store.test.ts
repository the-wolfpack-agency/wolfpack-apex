/**
 * Persistence for a walked map. The DB is mocked so the shape of what gets
 * written is the thing under test, which is where the mistakes live.
 */
const mockWrite = jest.fn();
const mockSafe = jest.fn();

jest.mock("@/lib/db", () => ({
  writeQuery: (...a: unknown[]) => mockWrite(...a),
  safeQuery: (...a: unknown[]) => mockSafe(...a),
}));

import { saveWalkedMap, listWalkedMaps, getWalkedMap } from "../store";
import type { SystemMap } from "../types";

const MAP: SystemMap = {
  platform: "cognito-forms",
  entryUrl: "https://forms.example/acme",
  surfaces: [
    {
      url: "https://forms.example/acme/crm/build",
      signature: "/acme/crm/build",
      title: null,
      depth: 1,
      headings: [],
      linksTo: [],
      forms: [
        { name: "crm", method: "post", fields: [], mutating: true },
        { name: "search", method: "get", fields: [], mutating: false },
      ],
      tables: [],
      status: 200,
      loadMs: 400,
    },
    {
      url: "https://forms.example/acme/users/build",
      signature: "/acme/users/build",
      title: null,
      depth: 1,
      headings: [],
      linksTo: [],
      /* The same search form again: two sightings, one form. */
      forms: [{ name: "search", method: "get", fields: [], mutating: false }],
      tables: [],
      status: 200,
      loadMs: 300,
    },
  ],
  entities: [{ name: "crm", evidence: [], attributes: ["email"] }],
  integrations: [],
  paths: [],
  coverage: {
    surfacesReached: 2,
    frontierRemaining: 34,
    skipped: [],
    patterns: [],
    maxDepthReached: 1,
    stopReason: "page-budget",
    durationMs: 1000,
  },
  generatedAt: "2026-08-30T00:00:00.000Z",
  headline: "",
};

beforeEach(() => {
  mockWrite.mockReset().mockResolvedValue({ rows: [] });
  mockSafe.mockReset().mockResolvedValue({ rows: [] });
});

const paramsOf = () => mockWrite.mock.calls[0][1] as unknown[];

describe("saving a walked map", () => {
  it("writes the denormalised counts alongside the document", async () => {
    await saveWalkedMap("ws-1", MAP, "CTO, Acme");
    const p = paramsOf();
    expect(p[0]).toBe("ws-1");
    expect(p[1]).toBe("cognito-forms");
    expect(p[2]).toBe("https://forms.example/acme");
    expect(p[4]).toBe(2); // surfaces
    expect(p[5]).toBe(1); // entities
  });

  /* A form seen on two screens is one form. Counting sightings would inflate
     the figure a client reads, which is the mistake the real run made before
     form-inventory existed: 94 forms on a 13-form system. */
  it("counts distinct forms, not sightings", async () => {
    await saveWalkedMap("ws-1", MAP, "CTO, Acme");
    expect(paramsOf()[6]).toBe(2);
  });

  /* NON-ZERO MEANS INCOMPLETE, so it is a column rather than a detail buried
     in the document nobody opens. */
  it("stores what the walk did not reach, and why it stopped", async () => {
    await saveWalkedMap("ws-1", MAP, "CTO, Acme");
    expect(paramsOf()[7]).toBe(34);
    expect(paramsOf()[8]).toBe("page-budget");
  });

  /* Walking somebody else's system is a permitted act. The record that it was
     permitted outlives the map, so it cannot be defaulted into existence. */
  it("refuses to store a walk nobody authorised", async () => {
    await expect(saveWalkedMap("ws-1", MAP, "  ")).rejects.toThrow(/authorised/i);
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it("keeps who authorised it", async () => {
    await saveWalkedMap("ws-1", MAP, "  CTO, Acme  ");
    expect(paramsOf()[9]).toBe("CTO, Acme");
  });

  it("replaces the prior snapshot for the same entry point", async () => {
    await saveWalkedMap("ws-1", MAP, "CTO, Acme");
    expect(mockWrite.mock.calls[0][0]).toMatch(/ON CONFLICT \(workspace_id, entry_url\) DO UPDATE/);
  });
});

describe("reading walked maps", () => {
  const dbRow = {
    platform: "cognito-forms",
    entry_url: "https://forms.example/acme",
    map: JSON.stringify(MAP),
    surface_count: 2,
    entity_count: 1,
    form_count: 2,
    frontier_remaining: 34,
    stop_reason: "page-budget",
    authorised_by: "CTO, Acme",
    generated_at: new Date("2026-08-30T00:00:00.000Z"),
  };

  it("parses a document stored as text", async () => {
    mockSafe.mockResolvedValue({ rows: [dbRow] });
    const [row] = await listWalkedMaps("ws-1");
    expect(row.map.entities[0].name).toBe("crm");
    expect(row.generatedAt).toBe("2026-08-30T00:00:00.000Z");
  });

  it("takes a document already parsed by the driver", async () => {
    mockSafe.mockResolvedValue({ rows: [{ ...dbRow, map: MAP }] });
    const [row] = await listWalkedMaps("ws-1");
    expect(row.map.platform).toBe("cognito-forms");
  });

  it("scopes to the workspace", async () => {
    await listWalkedMaps("ws-1");
    expect(mockSafe.mock.calls[0][1]).toEqual(["ws-1"]);
    expect(mockSafe.mock.calls[0][0]).toMatch(/workspace_id = \$1/);
  });

  it("returns nothing rather than throwing when there is no map", async () => {
    expect(await getWalkedMap("ws-1", "https://nothing.example")).toBeNull();
    expect(await listWalkedMaps("ws-1")).toEqual([]);
  });
});
