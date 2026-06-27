/**
 * SystemProfile persistence test: the db boundary is mocked, so the upsert
 * shape (one row per workspace+platform), the denormalized scalar params, and
 * the JSON round-trip on read are all asserted without a database.
 */
const mockWriteQuery = jest.fn();
const mockSafeQuery = jest.fn();

jest.mock("@/lib/db", () => ({
  writeQuery: (...a: unknown[]) => mockWriteQuery(...a),
  safeQuery: (...a: unknown[]) => mockSafeQuery(...a),
}));

import { saveSystemProfile, getSystemProfile } from "@/lib/platform-scan/profile/store";
import type { SystemProfile } from "@/lib/platform-scan/profile/types";

const PROFILE: SystemProfile = {
  platform: "acme",
  surface: { pages: 2, apiRoutes: 3, components: 1, libModules: 4, migrations: 5, tests: 6, totalFiles: 21 },
  entities: ["leads", "deals"],
  integrations: [{ name: "Stripe", package: "stripe", category: "Payments" }],
  authModel: { publicRoutes: 2, protectedRoutes: 3 },
  riskSummary: { critical: 1, high: 0, medium: 0, low: 0, total: 1 },
  generatedAt: "2026-06-26T00:00:00.000Z",
};

beforeEach(() => jest.clearAllMocks());

it("saveSystemProfile upserts on (workspace_id, platform) with denormalized scalars", async () => {
  mockWriteQuery.mockResolvedValue({ rows: [] });
  await saveSystemProfile("ws-1", PROFILE);

  expect(mockWriteQuery).toHaveBeenCalledTimes(1);
  const [sql, params] = mockWriteQuery.mock.calls[0];
  expect(sql).toMatch(/INSERT INTO instinct_system_profiles/);
  expect(sql).toMatch(/ON CONFLICT \(workspace_id, platform\) DO UPDATE/);
  // workspace, platform, JSON profile, entity count, integration count,
  // route count (public+protected = 5), critical count.
  expect(params).toEqual([
    "ws-1",
    "acme",
    JSON.stringify(PROFILE),
    2,
    1,
    5,
    1,
  ]);
});

it("getSystemProfile parses a JSON-string profile column into an object", async () => {
  mockSafeQuery.mockResolvedValue({
    rows: [
      {
        platform: "acme",
        profile: JSON.stringify(PROFILE),
        entity_count: 2,
        integration_count: 1,
        route_count: 5,
        critical_count: 1,
        generated_at: "2026-06-26T00:00:00.000Z",
      },
    ],
  });
  const row = await getSystemProfile("ws-1", "acme");
  expect(row).not.toBeNull();
  expect(row!.platform).toBe("acme");
  expect(row!.profile.platform).toBe("acme");
  expect(row!.profile.entities).toEqual(["leads", "deals"]);
  expect(row!.entityCount).toBe(2);
  expect(mockSafeQuery.mock.calls[0][1]).toEqual(["ws-1", "acme"]);
});

it("getSystemProfile returns null when no row exists", async () => {
  mockSafeQuery.mockResolvedValue({ rows: [] });
  expect(await getSystemProfile("ws-1", "nope")).toBeNull();
});
