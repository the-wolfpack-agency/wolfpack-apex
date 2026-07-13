/**
 * Contract tests for POST /api/planner/tasks — the assignment path.
 *
 * Assigning a task to an individual maps to Planner (Microsoft To Do has no
 * `assignments` in Graph). Pins: auth (401), planId/title/assignees input
 * validation (400), the scope_missing → 403 mapping (Graph 403), and the
 * happy path forwarding assignees to the integration + returning 201.
 */

export {};

const mockGetUser = jest.fn();
const mockCreateTask = jest.fn();
const mockTrack = jest.fn();
const mockRecordAudit = jest.fn();

jest.mock("@/lib/auth", () => ({
  getUserFromRequest: (...a: unknown[]) => mockGetUser(...a),
}));
jest.mock("@/lib/integrations/microsoft-planner", () => ({
  createTask: (...a: unknown[]) => mockCreateTask(...a),
}));
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: unknown[]) => mockTrack(...a),
}));
jest.mock("@/lib/audit-log", () => ({
  recordAudit: (...a: unknown[]) => mockRecordAudit(...a),
}));

import { NextRequest } from "next/server";
import { POST } from "../route";

function req(body: unknown): NextRequest {
  return new NextRequest("https://x.test/api/planner/tasks", {
    method: "POST",
    headers: { authorization: "Bearer test", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockTrack.mockResolvedValue(undefined);
  mockRecordAudit.mockResolvedValue(undefined);
  mockGetUser.mockReturnValue({ id: "u1", role: "member" });
});

describe("POST /api/planner/tasks", () => {
  it("401 when unauthenticated", async () => {
    mockGetUser.mockReturnValue(null);
    const res = await POST(req({ planId: "p1", title: "x", assignees: ["a"] }));
    expect(res.status).toBe(401);
    expect(mockCreateTask).not.toHaveBeenCalled();
  });

  it("400 when planId missing", async () => {
    const res = await POST(req({ title: "x" }));
    expect(res.status).toBe(400);
  });

  it("400 when assignees is not an array", async () => {
    const res = await POST(req({ planId: "p1", title: "x", assignees: "nope" }));
    expect(res.status).toBe(400);
  });

  it("403 when Graph reports the scope is missing", async () => {
    mockCreateTask.mockResolvedValue({ ok: false, code: "scope_missing", scope: "Tasks.ReadWrite.Shared" });
    const res = await POST(req({ planId: "p1", title: "x", assignees: ["11111111-1111-1111-1111-111111111111"] }));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("scope_missing");
    expect(body.scope).toBe("Tasks.ReadWrite.Shared");
  });

  it("201 and forwards assignees to the integration", async () => {
    const uid = "11111111-1111-1111-1111-111111111111";
    mockCreateTask.mockResolvedValue({
      ok: true,
      value: { id: "ms-task-1", task: { msTaskId: "ms-task-1", planId: "p1", title: "x", assignees: [uid] } },
    });
    const res = await POST(req({ planId: "p1", title: "Assign me", assignees: [uid], dueAt: null }));
    expect(res.status).toBe(201);
    expect(mockCreateTask).toHaveBeenCalledWith(
      "u1",
      "member",
      expect.objectContaining({ planId: "p1", title: "Assign me", assignees: [uid] }),
    );
  });
});
