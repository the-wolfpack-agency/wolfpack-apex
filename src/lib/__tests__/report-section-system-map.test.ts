/**
 * The System Map section is a client deliverable, so it must render real
 * SystemProfile data into Markdown, degrade to an explicit empty-state on no
 * data / store error, and never throw / never blank. The profile store is
 * mocked so the section is tested in isolation.
 */
const mockListSystemProfiles = jest.fn();

jest.mock("@/lib/platform-scan/profile/store", () => ({
  listSystemProfiles: (...a: unknown[]) => mockListSystemProfiles(...a),
}));

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
