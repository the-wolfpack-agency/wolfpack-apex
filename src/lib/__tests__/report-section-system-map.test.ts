/**
 * The System Map section is a client deliverable, so it must render real
 * SystemProfile data into Markdown, degrade to an explicit empty-state on no
 * data / store error, and never throw / never blank. The profile store is
 * mocked so the section is tested in isolation.
 */
const mockListSystemProfiles = jest.fn();
const mockListWalkedMaps = jest.fn();

jest.mock("@/lib/platform-scan/profile/store", () => ({
  listSystemProfiles: (...a: unknown[]) => mockListSystemProfiles(...a),
}));
jest.mock("@/lib/platform-scan/mapping/store", () => ({
  listWalkedMaps: (...a: unknown[]) => mockListWalkedMaps(...a),
}));

beforeEach(() => mockListWalkedMaps.mockResolvedValue([]));

import { genSystemMap } from "@/lib/report-sections-engagement";
import type { SystemProfile } from "@/lib/platform-scan/profile/types";

const ctx = { clientName: "Acme", workspaceId: "ws-1" };

const PROFILE: SystemProfile = {
  platform: "acme-crm",
  surface: { pages: 4, apiRoutes: 12, components: 8, libModules: 20, migrations: 6, tests: 30, totalFiles: 120 },
  entities: ["leads", "deals", "contacts"],
  integrations: [
    { name: "Stripe", package: "stripe", category: "Payments" },
    { name: "Twilio", package: "twilio", category: "SMS/Voice" },
  ],
  authModel: { publicRoutes: 3, protectedRoutes: 9 },
  riskSummary: { critical: 1, high: 2, medium: 0, low: 0, total: 3 },
  generatedAt: "2026-06-26T00:00:00.000Z",
};

const row = (p: SystemProfile) => ({
  platform: p.platform,
  profile: p,
  entityCount: p.entities.length,
  integrationCount: p.integrations.length,
  routeCount: p.authModel.publicRoutes + p.authModel.protectedRoutes,
  criticalCount: p.riskSummary.critical,
  generatedAt: p.generatedAt,
});

beforeEach(() => jest.clearAllMocks());

it("renders the heading, platform, integrations, and entities from the profile", async () => {
  mockListSystemProfiles.mockResolvedValue([row(PROFILE)]);
  const md = await genSystemMap(ctx);
  expect(md).toMatch(/## System Map/);
  expect(md).toContain("### acme-crm");
  expect(md).toContain("Stripe (Payments)");
  expect(md).toContain("Twilio (SMS/Voice)");
  expect(md).toContain("leads");
  expect(md).toContain("contacts");
  // Auth posture is surfaced.
  expect(md).toMatch(/9 protected/);
  expect(md).toMatch(/3 public/);
});

it("renders the explicit empty-state line when there are no profiles", async () => {
  mockListSystemProfiles.mockResolvedValue([]);
  const md = await genSystemMap(ctx);
  expect(md).toMatch(/## System Map/);
  expect(md).toContain("No system profile has been generated yet");
});

it("degrades to the empty-state line on a store error (never throws)", async () => {
  mockListSystemProfiles.mockRejectedValue(new Error("db down"));
  const md = await genSystemMap(ctx);
  expect(md).toMatch(/## System Map/);
  expect(md).toContain("No system profile has been generated yet");
});

/**
 * Systems learned by WALKING them, which is a different kind of knowledge from
 * reading a repository and is labelled as such in a document a client reads.
 */
describe("walked systems in the System Map", () => {
  const walkedRow = (over: Record<string, unknown> = {}) => ({
    platform: "cognito-forms",
    entryUrl: "https://forms.example/acme",
    surfaceCount: 19,
    entityCount: 13,
    formCount: 13,
    frontierRemaining: 0,
    stopReason: "frontier-exhausted",
    authorisedBy: "CTO, Acme",
    generatedAt: "2026-08-30T00:00:00.000Z",
    map: {
      platform: "cognito-forms",
      entryUrl: "https://forms.example/acme",
      surfaces: [],
      entities: [
        { name: "porschecrm", evidence: [], attributes: ["centerNumber", "emailAddress"] },
      ],
      integrations: [],
      paths: [],
      coverage: {
        surfacesReached: 19,
        frontierRemaining: 0,
        skipped: [],
        patterns: [
          { shape: "/acme/*/publish", instances: ["a", "b", "c", "d"], visited: 2 },
        ],
        maxDepthReached: 2,
        stopReason: "frontier-exhausted",
        durationMs: 1000,
      },
      generatedAt: "2026-08-30T00:00:00.000Z",
      headline: "",
    },
    ...over,
  });

  it("renders a walked map when nothing has been profiled", async () => {
    mockListSystemProfiles.mockResolvedValue([]);
    mockListWalkedMaps.mockResolvedValue([walkedRow()]);
    const md = await genSystemMap(ctx);
    expect(md).toContain("cognito-forms");
    expect(md).toContain("porschecrm");
    /* Saying "nothing has been profiled" while holding a map would be the
       report contradicting its own contents. */
    expect(md).not.toContain("No system profile has been generated");
  });

  /* THE DISTINCTION A READER MUST NOT LOSE. A profile read the source; a walk
     saw the outside of a running product. They support different claims. */
  it("says the system was walked rather than read", async () => {
    mockListSystemProfiles.mockResolvedValue([]);
    mockListWalkedMaps.mockResolvedValue([walkedRow()]);
    const md = await genSystemMap(ctx);
    expect(md).toMatch(/walked, not read/i);
    expect(md).toMatch(/unknown rather than zero/i);
  });

  /* The thing that would embarrass us in front of a client: telling them their
     system is smaller than it is because the walk ran out of budget. */
  it("says the map is incomplete, next to the counts", async () => {
    mockListSystemProfiles.mockResolvedValue([]);
    mockListWalkedMaps.mockResolvedValue([
      walkedRow({ frontierRemaining: 34, stopReason: "page-budget" }),
    ]);
    const md = await genSystemMap(ctx);
    expect(md).toMatch(/incomplete/i);
    expect(md).toContain("34");
    expect(md).toContain("page-budget");
    expect(md).toMatch(/floor, not a total/i);
  });

  it("does not claim incompleteness when the walk finished", async () => {
    mockListSystemProfiles.mockResolvedValue([]);
    mockListWalkedMaps.mockResolvedValue([walkedRow()]);
    expect(await genSystemMap(ctx)).not.toMatch(/This map is incomplete/i);
  });

  it("says which repeated screens were sampled rather than walked", async () => {
    mockListSystemProfiles.mockResolvedValue([]);
    mockListWalkedMaps.mockResolvedValue([walkedRow()]);
    const md = await genSystemMap(ctx);
    expect(md).toMatch(/sampled, not walked/i);
    expect(md).toContain("4 exist, 2 opened");
  });

  /* Walking somebody else's system is a permitted act, and the record that it
     was permitted belongs in the deliverable. */
  it("names who authorised the walk", async () => {
    mockListSystemProfiles.mockResolvedValue([]);
    mockListWalkedMaps.mockResolvedValue([walkedRow()]);
    expect(await genSystemMap(ctx)).toContain("CTO, Acme");
  });

  it("renders both kinds when both exist, without merging them", async () => {
    mockListSystemProfiles.mockResolvedValue([row(PROFILE)]);
    mockListWalkedMaps.mockResolvedValue([walkedRow()]);
    const md = await genSystemMap(ctx);
    expect(md).toContain("acme-crm");
    expect(md).toContain("cognito-forms");
    expect(md).toMatch(/walked, not read/i);
  });

  it("still renders the profiled section when the walked store fails", async () => {
    mockListSystemProfiles.mockResolvedValue([row(PROFILE)]);
    mockListWalkedMaps.mockRejectedValue(new Error("store down"));
    const md = await genSystemMap(ctx);
    expect(md).toContain("acme-crm");
  });
});
