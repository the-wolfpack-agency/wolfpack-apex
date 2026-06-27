/**
 * github_app_installations storage helpers.
 *
 * db (safeQuery/writeQuery) + analytics (trackEvent) are mocked. Asserts:
 *   - getInstallation maps a row → camelCase shape, returns null on no rows.
 *   - linkInstallation upserts + fires platform.github_installation_linked.
 *   - removeInstallation fires platform.github_installation_removed only when a
 *     row existed (idempotent: returns false + no event otherwise).
 * NEVER hits a real DB.
 */

const mockSafeQuery = jest.fn();
const mockWriteQuery = jest.fn();
jest.mock("@/lib/db", () => ({
  safeQuery: (...a: unknown[]) => mockSafeQuery(...a),
  writeQuery: (...a: unknown[]) => mockWriteQuery(...a),
}));

const mockTrack = jest.fn();
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: unknown[]) => mockTrack(...a),
}));

import {
  getInstallation,
  linkInstallation,
  removeInstallation,
} from "@/lib/github-app/storage";

beforeEach(() => jest.clearAllMocks());

describe("getInstallation", () => {
  it("maps a row to the camelCase shape", async () => {
    mockSafeQuery.mockResolvedValueOnce({
      rows: [
        {
          workspace_id: "ws1",
          installation_id: "42",
          account_login: "acme",
          linked_at: "2026-06-01T00:00:00.000Z",
          linked_by: "u1",
        },
      ],
      fromCache: false,
    });
    const inst = await getInstallation("ws1");
    expect(inst).toEqual({
      workspaceId: "ws1",
      installationId: "42",
      accountLogin: "acme",
      linkedAt: "2026-06-01T00:00:00.000Z",
      linkedBy: "u1",
    });
  });

  it("returns null when there is no row (or shadow mode)", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [], fromCache: true });
    expect(await getInstallation("ws1")).toBeNull();
  });
});

describe("linkInstallation", () => {
  it("upserts and fires platform.github_installation_linked", async () => {
    mockWriteQuery.mockResolvedValueOnce({
      rows: [
        {
          workspace_id: "ws1",
          installation_id: "42",
          account_login: "acme",
          linked_at: "2026-06-01T00:00:00.000Z",
          linked_by: "u1",
        },
      ],
    });
    const inst = await linkInstallation({
      workspaceId: "ws1",
      installationId: "42",
      accountLogin: "acme",
      linkedBy: "u1",
      actorRole: "cto",
    });
    expect(inst.installationId).toBe("42");
    // Upsert via ON CONFLICT, expectRows: 1.
    const [sql, params, opts] = mockWriteQuery.mock.calls[0];
    expect(sql).toMatch(/ON CONFLICT/i);
    expect(params).toEqual(["ws1", "42", "acme", "u1"]);
    expect(opts).toEqual({ expectRows: 1 });
    expect(mockTrack).toHaveBeenCalledWith(
      "platform.github_installation_linked",
      "u1",
      "cto",
      expect.objectContaining({
        workspace_id: "ws1",
        installation_id: "42",
        account_login: "acme",
      }),
    );
  });
});

describe("removeInstallation", () => {
  it("fires platform.github_installation_removed when a row existed", async () => {
    mockWriteQuery.mockResolvedValueOnce({ rows: [{ installation_id: "42" }] });
    const removed = await removeInstallation({
      workspaceId: "ws1",
      removedBy: "u1",
      actorRole: "cto",
    });
    expect(removed).toBe(true);
    expect(mockTrack).toHaveBeenCalledWith(
      "platform.github_installation_removed",
      "u1",
      "cto",
      expect.objectContaining({ workspace_id: "ws1", installation_id: "42" }),
    );
  });

  it("is idempotent: returns false and fires nothing when nothing to remove", async () => {
    mockWriteQuery.mockResolvedValueOnce({ rows: [] });
    const removed = await removeInstallation({ workspaceId: "ws1", removedBy: "u1" });
    expect(removed).toBe(false);
    expect(mockTrack).not.toHaveBeenCalled();
  });
});
