/**
 * /api/automations/[automationId]/audit/[id]/revert — handler tests.
 *
 * Covers:
 *   - 401 without auth
 *   - 404 unknown automation / unknown action_id / wrong automation_id
 *   - 409 already reverted
 *   - 410 over the 24h window
 *   - 502 when revert handler returns ok:false
 *   - 200 happy paths for each of the three action kinds
 *   - 409 race — concurrent revert flips the row between checks
 */

const mockRequireCapability = jest.fn();
jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: (...args: unknown[]) => mockRequireCapability(...args),
}));

const fakeAutomation = {
  id: "porsche-classes",
  name: "Porsche",
  owner_label: "Alicia",
  description: "test",
  active_window_days: { min: -7, max: 30 },
  inbox_filters: {},
  parsers: {},
};
jest.mock("@/lib/automations/registry", () => ({
  getAutomation: (id: string) =>
    id === "porsche-classes" ? fakeAutomation : null,
}));

const mockGetActionById = jest.fn();
const mockRevertAction = jest.fn();
jest.mock("@/lib/automations/porsche-classes/audit-repo", () => ({
  ...jest.requireActual("@/lib/automations/porsche-classes/audit-repo"),
  getActionById: (...args: unknown[]) => mockGetActionById(...args),
  revertAction: (...args: unknown[]) => mockRevertAction(...args),
}));

const mockClassMerge = jest.fn();
const mockSharepoint = jest.fn();
const mockSplit = jest.fn();
jest.mock("@/lib/automations/porsche-classes/audit-revert", () => ({
  revertClassMatchMerge: (...args: unknown[]) => mockClassMerge(...args),
  revertSharepointUpload: (...args: unknown[]) => mockSharepoint(...args),
  revertSurveyAutoSplit: (...args: unknown[]) => mockSplit(...args),
}));

const mockTrackEvent = jest.fn();
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...args: unknown[]) => mockTrackEvent(...args),
}));

import { NextRequest, NextResponse } from "next/server";
import { POST } from "@/app/api/automations/[automationId]/audit/[id]/revert/route";

function req(): NextRequest {
  return new NextRequest(
    "http://test/api/automations/porsche-classes/audit/a-1/revert",
    { method: "POST" },
  );
}
const USER = { id: "u-1", role: "ops", name: "A", email: "a@b.com" };

const fresh = (deltaMs = -60_000) =>
  new Date(Date.now() + deltaMs).toISOString();

beforeEach(() => {
  jest.clearAllMocks();
});

describe("POST /api/automations/[automationId]/audit/[id]/revert", () => {
  it("401 without auth", async () => {
    mockRequireCapability.mockResolvedValueOnce({
      ok: false,
      response: NextResponse.json({ error: "unauthorized" }, { status: 401 }),
    });
    const res = await POST(req(), {
      params: Promise.resolve({ automationId: "porsche-classes", id: "a-1" }),
    });
    expect(res.status).toBe(401);
    expect(mockGetActionById).not.toHaveBeenCalled();
  });

  it("404 for an unknown automation", async () => {
    mockRequireCapability.mockResolvedValueOnce({
      ok: true,
      user: USER,
      capabilities: new Set(),
    });
    const res = await POST(req(), {
      params: Promise.resolve({ automationId: "not-a-real", id: "a-1" }),
    });
    expect(res.status).toBe(404);
  });

  it("404 when the audit action doesn't exist", async () => {
    mockRequireCapability.mockResolvedValueOnce({
      ok: true,
      user: USER,
      capabilities: new Set(),
    });
    mockGetActionById.mockResolvedValueOnce(null);
    const res = await POST(req(), {
      params: Promise.resolve({ automationId: "porsche-classes", id: "a-1" }),
    });
    expect(res.status).toBe(404);
  });

  it("404 when action_id belongs to a different automation_id", async () => {
    mockRequireCapability.mockResolvedValueOnce({
      ok: true,
      user: USER,
      capabilities: new Set(),
    });
    mockGetActionById.mockResolvedValueOnce({
      id: "a-1",
      automation_id: "different-automation",
      action_kind: "class_match_merge",
      target_ref: "k",
      detail: { override_id: "o-1", from_value: "a", to_value: "b" },
      actor: "x",
      reverted_at: null,
      reverted_by: null,
      created_at: fresh(),
    });
    const res = await POST(req(), {
      params: Promise.resolve({ automationId: "porsche-classes", id: "a-1" }),
    });
    expect(res.status).toBe(404);
  });

  it("409 when the action is already reverted", async () => {
    mockRequireCapability.mockResolvedValueOnce({
      ok: true,
      user: USER,
      capabilities: new Set(),
    });
    mockGetActionById.mockResolvedValueOnce({
      id: "a-1",
      automation_id: "porsche-classes",
      action_kind: "sharepoint_upload",
      target_ref: "k",
      detail: { item_id: "01" },
      actor: "x",
      reverted_at: new Date().toISOString(),
      reverted_by: "y",
      created_at: fresh(),
    });
    const res = await POST(req(), {
      params: Promise.resolve({ automationId: "porsche-classes", id: "a-1" }),
    });
    expect(res.status).toBe(409);
    expect(mockSharepoint).not.toHaveBeenCalled();
  });

  it("410 when the action is older than 24h", async () => {
    mockRequireCapability.mockResolvedValueOnce({
      ok: true,
      user: USER,
      capabilities: new Set(),
    });
    mockGetActionById.mockResolvedValueOnce({
      id: "a-1",
      automation_id: "porsche-classes",
      action_kind: "sharepoint_upload",
      target_ref: "k",
      detail: { item_id: "01" },
      actor: "x",
      reverted_at: null,
      reverted_by: null,
      // 25h ago
      created_at: fresh(-25 * 60 * 60 * 1000),
    });
    const res = await POST(req(), {
      params: Promise.resolve({ automationId: "porsche-classes", id: "a-1" }),
    });
    expect(res.status).toBe(410);
    expect(mockSharepoint).not.toHaveBeenCalled();
  });

  it("502 when the revert handler returns ok:false", async () => {
    mockRequireCapability.mockResolvedValueOnce({
      ok: true,
      user: USER,
      capabilities: new Set(),
    });
    mockGetActionById.mockResolvedValueOnce({
      id: "a-1",
      automation_id: "porsche-classes",
      action_kind: "sharepoint_upload",
      target_ref: "k",
      detail: { item_id: "01" },
      actor: "x",
      reverted_at: null,
      reverted_by: null,
      created_at: fresh(),
    });
    mockSharepoint.mockResolvedValueOnce({
      ok: false,
      error: "Graph 403",
    });
    const res = await POST(req(), {
      params: Promise.resolve({ automationId: "porsche-classes", id: "a-1" }),
    });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toMatch(/Graph 403/);
    expect(mockRevertAction).not.toHaveBeenCalled();
  });

  it("200 happy path for class_match_merge", async () => {
    mockRequireCapability.mockResolvedValueOnce({
      ok: true,
      user: USER,
      capabilities: new Set(),
    });
    mockGetActionById.mockResolvedValueOnce({
      id: "a-1",
      automation_id: "porsche-classes",
      action_kind: "class_match_merge",
      target_ref: "k",
      detail: { override_id: "o-1", from_value: "a", to_value: "b" },
      actor: "x",
      reverted_at: null,
      reverted_by: null,
      created_at: fresh(),
    });
    mockClassMerge.mockResolvedValueOnce({ ok: true });
    mockRevertAction.mockResolvedValueOnce({
      id: "a-1",
      reverted_at: "now",
      reverted_by: "a@b.com",
    });
    const res = await POST(req(), {
      params: Promise.resolve({ automationId: "porsche-classes", id: "a-1" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(mockClassMerge).toHaveBeenCalledTimes(1);
    expect(mockRevertAction).toHaveBeenCalledWith("a-1", "a@b.com");
  });

  it("200 happy path for sharepoint_upload (passes user creds)", async () => {
    mockRequireCapability.mockResolvedValueOnce({
      ok: true,
      user: USER,
      capabilities: new Set(),
    });
    mockGetActionById.mockResolvedValueOnce({
      id: "a-1",
      automation_id: "porsche-classes",
      action_kind: "sharepoint_upload",
      target_ref: "k",
      detail: { item_id: "01" },
      actor: "x",
      reverted_at: null,
      reverted_by: null,
      created_at: fresh(),
    });
    mockSharepoint.mockResolvedValueOnce({ ok: true });
    mockRevertAction.mockResolvedValueOnce({ id: "a-1" });
    const res = await POST(req(), {
      params: Promise.resolve({ automationId: "porsche-classes", id: "a-1" }),
    });
    expect(res.status).toBe(200);
    const callArgs = mockSharepoint.mock.calls[0];
    expect(callArgs[1]).toEqual({
      userId: "u-1",
      userEmail: "a@b.com",
    });
  });

  it("200 happy path for survey_auto_split", async () => {
    mockRequireCapability.mockResolvedValueOnce({
      ok: true,
      user: USER,
      capabilities: new Set(),
    });
    mockGetActionById.mockResolvedValueOnce({
      id: "a-1",
      automation_id: "porsche-classes",
      action_kind: "survey_auto_split",
      target_ref: "art-1",
      detail: { snapshot_ids: ["s1", "s2"] },
      actor: "system",
      reverted_at: null,
      reverted_by: null,
      created_at: fresh(),
    });
    mockSplit.mockResolvedValueOnce({ ok: true });
    mockRevertAction.mockResolvedValueOnce({ id: "a-1" });
    const res = await POST(req(), {
      params: Promise.resolve({ automationId: "porsche-classes", id: "a-1" }),
    });
    expect(res.status).toBe(200);
    expect(mockSplit).toHaveBeenCalledTimes(1);
  });

  it("409 when revertAction returns null (concurrent revert)", async () => {
    mockRequireCapability.mockResolvedValueOnce({
      ok: true,
      user: USER,
      capabilities: new Set(),
    });
    mockGetActionById.mockResolvedValueOnce({
      id: "a-1",
      automation_id: "porsche-classes",
      action_kind: "class_match_merge",
      target_ref: "k",
      detail: { override_id: "o-1", from_value: "a", to_value: "b" },
      actor: "x",
      reverted_at: null,
      reverted_by: null,
      created_at: fresh(),
    });
    mockClassMerge.mockResolvedValueOnce({ ok: true });
    mockRevertAction.mockResolvedValueOnce(null);
    const res = await POST(req(), {
      params: Promise.resolve({ automationId: "porsche-classes", id: "a-1" }),
    });
    expect(res.status).toBe(409);
  });
});
