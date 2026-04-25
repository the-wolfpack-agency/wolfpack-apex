/**
 * /api/automations/[automationId]/audit — handler tests.
 *
 * Auth, unknown automation, happy path with class_key + since query
 * params, and `revertable` decoration.
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

const mockListActions = jest.fn();
jest.mock("@/lib/automations/porsche-classes/audit-repo", () => ({
  ...jest.requireActual("@/lib/automations/porsche-classes/audit-repo"),
  listActionsForAutomation: (...args: unknown[]) => mockListActions(...args),
}));

import { NextRequest, NextResponse } from "next/server";
import { GET } from "@/app/api/automations/[automationId]/audit/route";

function req(query = ""): NextRequest {
  return new NextRequest(
    `http://test/api/automations/porsche-classes/audit${query}`,
    { method: "GET" },
  );
}
const USER = { id: "u-1", role: "ops", name: "A", email: "a@b.com" };

beforeEach(() => {
  jest.clearAllMocks();
});

describe("GET /api/automations/[automationId]/audit", () => {
  it("401 without auth", async () => {
    mockRequireCapability.mockResolvedValueOnce({
      ok: false,
      response: NextResponse.json({ error: "unauthorized" }, { status: 401 }),
    });
    const res = await GET(req(), {
      params: Promise.resolve({ automationId: "porsche-classes" }),
    });
    expect(res.status).toBe(401);
    expect(mockListActions).not.toHaveBeenCalled();
  });

  it("404 for an unknown automation", async () => {
    mockRequireCapability.mockResolvedValueOnce({
      ok: true,
      user: USER,
      capabilities: new Set(),
    });
    const res = await GET(req(), {
      params: Promise.resolve({ automationId: "not-a-real" }),
    });
    expect(res.status).toBe(404);
    expect(mockListActions).not.toHaveBeenCalled();
  });

  it("happy path — passes class_key + since to the repo, decorates revertable", async () => {
    mockRequireCapability.mockResolvedValueOnce({
      ok: true,
      user: USER,
      capabilities: new Set(),
    });
    const now = new Date();
    const fresh = new Date(now.getTime() - 60_000).toISOString();
    const expired = new Date(now.getTime() - 25 * 3600 * 1000).toISOString();
    mockListActions.mockResolvedValueOnce([
      {
        id: "a-1",
        automation_id: "porsche-classes",
        action_kind: "sharepoint_upload",
        target_ref: "k",
        detail: {},
        actor: "x",
        reverted_at: null,
        reverted_by: null,
        created_at: fresh,
      },
      {
        id: "a-2",
        automation_id: "porsche-classes",
        action_kind: "class_match_merge",
        target_ref: "k",
        detail: {},
        actor: "x",
        reverted_at: null,
        reverted_by: null,
        created_at: expired,
      },
      {
        id: "a-3",
        automation_id: "porsche-classes",
        action_kind: "sharepoint_upload",
        target_ref: "k",
        detail: {},
        actor: "x",
        reverted_at: now.toISOString(),
        reverted_by: "x",
        created_at: fresh,
      },
    ]);
    const res = await GET(req("?class_key=k&since=2026-04-25T00:00:00Z"), {
      params: Promise.resolve({ automationId: "porsche-classes" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.actions[0].revertable).toBe(true); // fresh, not reverted
    expect(body.actions[1].revertable).toBe(false); // expired
    expect(body.actions[2].revertable).toBe(false); // already reverted
    expect(mockListActions).toHaveBeenCalledWith({
      automation_id: "porsche-classes",
      class_key: "k",
      since: "2026-04-25T00:00:00Z",
      limit: undefined,
    });
  });
});
