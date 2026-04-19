/**
 * site-approvals.ts — orchestration tests.
 *
 * Mocks:
 *   - @/lib/db (safeQuery) — assert SQL + params
 *   - @/lib/analytics (trackEvent) — assert the right analytics event
 *     fires for every state transition
 *
 * Covers:
 *   - recordApproval inserts + fires site.approval_recorded
 *   - recordApproval for changes_requested fires site.changes_requested
 *   - via_share_token flag is correctly computed from shareTokenRowId
 *   - recordApproval surfaces shadow-mode row when DB returns empty
 *   - long comment / name / email are truncated before insert
 *   - listApprovalsForSite orders DESC
 *   - latestApprovalState returns first row or null
 *   - checkApprovalGate returns { allowed: true } always (locked
 *     contract — this test is the canary for the future gate flip)
 */

const safeQueryMock = jest.fn();
jest.mock("@/lib/db", () => ({
  safeQuery: (...args: unknown[]) => safeQueryMock(...args),
}));

const trackMock = jest.fn();
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...args: unknown[]) => trackMock(...args),
}));

import {
  recordApproval,
  listApprovalsForSite,
  latestApprovalState,
  checkApprovalGate,
} from "@/lib/site-approvals";

beforeEach(() => {
  jest.clearAllMocks();
});

describe("recordApproval", () => {
  const baseReturn = {
    id: "a1",
    site_id: "site_1",
    share_token_id: "tok_1",
    state: "approved",
    actor_name: "Alice",
    actor_email: "alice@example.com",
    comment: "Love it.",
    created_at: "2026-04-19T00:00:00Z",
  };

  it("inserts the row and fires site.approval_recorded", async () => {
    safeQueryMock.mockResolvedValueOnce({ rows: [baseReturn], fromCache: false });
    const rec = await recordApproval({
      siteId: "site_1",
      state: "approved",
      actorName: "Alice",
      actorEmail: "alice@example.com",
      comment: "Love it.",
      shareTokenRowId: "tok_1",
    });
    expect(rec.state).toBe("approved");
    expect(rec.viaShareToken).toBe(true);
    expect(rec.shareTokenId).toBe("tok_1");
    expect(trackMock).toHaveBeenCalledWith(
      "site.approval_recorded",
      "public",
      "client",
      expect.objectContaining({
        site_id: "site_1",
        state: "approved",
        via_share_token: true,
        has_comment: true,
        has_actor_email: true,
      }),
    );
  });

  it("fires site.changes_requested for that state", async () => {
    safeQueryMock.mockResolvedValueOnce({
      rows: [{ ...baseReturn, state: "changes_requested" }],
      fromCache: false,
    });
    await recordApproval({
      siteId: "site_2",
      state: "changes_requested",
      shareTokenRowId: "tok_2",
    });
    expect(trackMock).toHaveBeenCalledWith(
      "site.changes_requested",
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ state: "changes_requested" }),
    );
  });

  it("marks via_share_token=false for authed-user approvals", async () => {
    safeQueryMock.mockResolvedValueOnce({
      rows: [{ ...baseReturn, share_token_id: null }],
      fromCache: false,
    });
    const rec = await recordApproval({
      siteId: "site_3",
      state: "approved",
      userId: "u_42",
      userRole: "dev",
    });
    expect(rec.viaShareToken).toBe(false);
    expect(rec.shareTokenId).toBeNull();
    expect(trackMock).toHaveBeenCalledWith(
      "site.approval_recorded",
      "u_42",
      "dev",
      expect.objectContaining({ via_share_token: false }),
    );
  });

  it("synthesises a record in shadow mode (empty rows)", async () => {
    safeQueryMock.mockResolvedValueOnce({ rows: [], fromCache: true });
    const rec = await recordApproval({
      siteId: "site_shadow",
      state: "approved",
    });
    expect(rec.siteId).toBe("site_shadow");
    expect(rec.id).toMatch(/^approval_shadow_/);
    // Analytics still fires — no signal loss in shadow mode.
    expect(trackMock).toHaveBeenCalled();
  });

  it("truncates oversize fields before insert", async () => {
    safeQueryMock.mockResolvedValueOnce({ rows: [baseReturn], fromCache: false });
    const longComment = "x".repeat(5000);
    const longName = "y".repeat(500);
    await recordApproval({
      siteId: "site_4",
      state: "approved",
      actorName: longName,
      actorEmail: "c@d.com",
      comment: longComment,
    });
    const params = safeQueryMock.mock.calls[0][1];
    expect((params[3] as string).length).toBeLessThanOrEqual(200);
    expect((params[5] as string).length).toBeLessThanOrEqual(4000);
  });

  it("treats empty-string actor fields as null", async () => {
    safeQueryMock.mockResolvedValueOnce({ rows: [baseReturn], fromCache: false });
    await recordApproval({
      siteId: "site_5",
      state: "approved",
      actorName: "",
      actorEmail: "",
      comment: "",
    });
    const params = safeQueryMock.mock.calls[0][1];
    expect(params[3]).toBeNull();
    expect(params[4]).toBeNull();
    expect(params[5]).toBeNull();
  });
});

describe("listApprovalsForSite", () => {
  it("orders newest first", async () => {
    safeQueryMock.mockResolvedValueOnce({
      rows: [
        { id: "a2", site_id: "s1", state: "approved", created_at: "2026-04-19", share_token_id: null },
      ],
      fromCache: false,
    });
    const rows = await listApprovalsForSite("s1");
    expect(rows).toHaveLength(1);
    const sql = String(safeQueryMock.mock.calls[0][0]);
    expect(sql).toMatch(/ORDER BY created_at DESC/);
  });
});

describe("latestApprovalState", () => {
  it("returns null when no approvals exist", async () => {
    safeQueryMock.mockResolvedValueOnce({ rows: [], fromCache: false });
    const latest = await latestApprovalState("site_none");
    expect(latest).toBeNull();
  });

  it("returns the newest row with viaShareToken flag set", async () => {
    safeQueryMock.mockResolvedValueOnce({
      rows: [
        {
          id: "a9",
          site_id: "s1",
          share_token_id: "tok_9",
          state: "approved",
          created_at: "2026-04-19T00:00:00Z",
        },
      ],
      fromCache: false,
    });
    const latest = await latestApprovalState("s1");
    expect(latest?.state).toBe("approved");
    expect(latest?.viaShareToken).toBe(true);
  });
});

describe("checkApprovalGate", () => {
  it("always returns { allowed: true } in the current wave (locked contract)", async () => {
    // CONTRACT LOCK: when this test starts failing, the gate has been
    // flipped on. That MUST be intentional — see src/lib/site-approvals.ts
    // and the TODO in src/lib/sites.ts triggerDeploy.
    const r = await checkApprovalGate("site_any");
    expect(r.allowed).toBe(true);
  });

  it("does not read the DB in the current wave", async () => {
    await checkApprovalGate("site_any");
    // The gate is a pure return in the current wave, no SQL should run.
    expect(safeQueryMock).not.toHaveBeenCalled();
  });
});
