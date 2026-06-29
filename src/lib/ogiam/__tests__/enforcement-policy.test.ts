/**
 * Per-capability enforcement posture: resolution defaults + overrides, the
 * hot-path cache, set/delete cache invalidation, and FAIL-SAFE behavior (a DB
 * error resolves to the default, never throws). db is mocked.
 */

const mockSafeQuery = jest.fn();
const mockWriteQuery = jest.fn();
jest.mock("@/lib/db", () => ({
  safeQuery: (...a: unknown[]) => mockSafeQuery(...a),
  writeQuery: (...a: unknown[]) => mockWriteQuery(...a),
}));

import {
  resolveEnforcementMode,
  listEnforcementPolicy,
  setEnforcementPolicy,
  deleteEnforcementPolicy,
  __clearEnforcementCache,
} from "../enforcement-policy";

beforeEach(() => {
  jest.resetAllMocks();
  __clearEnforcementCache();
  mockSafeQuery.mockResolvedValue({ rows: [], fromCache: false });
  mockWriteQuery.mockResolvedValue({ rows: [] });
});

test("default when no override: agents enforce, the human assistant monitors", async () => {
  expect(await resolveEnforcementMode({ workspaceId: "w", capability: "tasks.write", isAgent: true })).toBe("enforce");
  __clearEnforcementCache();
  expect(await resolveEnforcementMode({ workspaceId: "w", capability: "tasks.write", isAgent: false })).toBe("monitor");
});

test("a per-capability override wins over the default (both directions)", async () => {
  mockSafeQuery.mockResolvedValue({ rows: [{ capability: "finance.write", mode: "enforce", updated_at: "t", updated_by: "u" }] });
  // human + enforce override -> enforce (graduated)
  expect(await resolveEnforcementMode({ workspaceId: "w", capability: "finance.write", isAgent: false })).toBe("enforce");
  // a capability with no row still falls back to default
  expect(await resolveEnforcementMode({ workspaceId: "w", capability: "tasks.write", isAgent: false })).toBe("monitor");

  __clearEnforcementCache();
  mockSafeQuery.mockResolvedValue({ rows: [{ capability: "tasks.write", mode: "monitor", updated_at: "t", updated_by: "u" }] });
  // agent + monitor override -> monitor (de-escalated)
  expect(await resolveEnforcementMode({ workspaceId: "w", capability: "tasks.write", isAgent: true })).toBe("monitor");
});

test("the per-workspace policy is cached: a second resolve does not re-hit the DB", async () => {
  await resolveEnforcementMode({ workspaceId: "w", capability: "a", isAgent: true });
  await resolveEnforcementMode({ workspaceId: "w", capability: "b", isAgent: true });
  expect(mockSafeQuery).toHaveBeenCalledTimes(1);
});

test("set/delete invalidate the workspace cache", async () => {
  await resolveEnforcementMode({ workspaceId: "w", capability: "a", isAgent: true }); // load (1)
  await setEnforcementPolicy({ workspaceId: "w", capability: "a", mode: "enforce", updatedBy: "u" });
  await resolveEnforcementMode({ workspaceId: "w", capability: "a", isAgent: true }); // reload (2)
  expect(mockSafeQuery).toHaveBeenCalledTimes(2);
  await deleteEnforcementPolicy("w", "a");
  await resolveEnforcementMode({ workspaceId: "w", capability: "a", isAgent: true }); // reload (3)
  expect(mockSafeQuery).toHaveBeenCalledTimes(3);
});

test("FAIL-SAFE: a DB error resolves to the default, never throws", async () => {
  mockSafeQuery.mockRejectedValue(new Error("db down"));
  expect(await resolveEnforcementMode({ workspaceId: "w", capability: "finance.write", isAgent: true })).toBe("enforce");
  expect(await resolveEnforcementMode({ workspaceId: "w", capability: "finance.write", isAgent: false })).toBe("monitor");
});

test("setEnforcementPolicy upserts on (workspace_id, capability)", async () => {
  await setEnforcementPolicy({ workspaceId: "w", capability: "mail.send", mode: "enforce", updatedBy: "admin" });
  const [sql, args] = mockWriteQuery.mock.calls[0];
  expect(sql).toMatch(/INSERT INTO ogiam_enforcement_policy/i);
  expect(sql).toMatch(/ON CONFLICT \(workspace_id, capability\)/i);
  expect(args).toEqual(["w", "mail.send", "enforce", "admin"]);
});

test("listEnforcementPolicy maps rows for the admin view", async () => {
  mockSafeQuery.mockResolvedValue({ rows: [{ capability: "mail.send", mode: "enforce", updated_at: "2026-06-29", updated_by: "admin" }] });
  const rows = await listEnforcementPolicy("w");
  expect(rows).toEqual([{ capability: "mail.send", mode: "enforce", updatedAt: "2026-06-29", updatedBy: "admin" }]);
});
