/**
 * Contract tests for /api/tasks (POST) + /api/tasks/[id] (PATCH).
 *
 * Pins: auth (401), the new Outlook field validation (400 on bad
 * reminder/start/categories), and that valid create/update pass the enriched
 * fields (startAt, reminderAt, isReminderOn, categories) through to the
 * integration. The tasks routes authenticate via getUserFromRequest (they are
 * allowlisted in CAPABILITY_ALLOWLIST), so we mock that + the integration.
 */

export {};

const mockGetUser = jest.fn();
const mockCreateTask = jest.fn();
const mockUpdateTask = jest.fn();
const mockDeleteTask = jest.fn();
const mockResolveDefaultListId = jest.fn();
const mockListCachedTasks = jest.fn();
const mockGetCachedTaskById = jest.fn();
const mockTrack = jest.fn();
const mockSafeQuery = jest.fn();

// The real validator + error class are pure — import them, don't mock, so the
// route's validation is exercised for real.
const actualTasks = jest.requireActual("@/lib/integrations/microsoft-tasks");

jest.mock("@/lib/auth", () => ({
  getUserFromRequest: (...a: unknown[]) => mockGetUser(...a),
}));
jest.mock("@/lib/integrations/microsoft-tasks", () => ({
  validateOutlookTaskFields: actualTasks.validateOutlookTaskFields,
  GraphTasksError: actualTasks.GraphTasksError,
  createTask: (...a: unknown[]) => mockCreateTask(...a),
  updateTask: (...a: unknown[]) => mockUpdateTask(...a),
  deleteTask: (...a: unknown[]) => mockDeleteTask(...a),
  resolveDefaultListId: (...a: unknown[]) => mockResolveDefaultListId(...a),
  listCachedTasks: (...a: unknown[]) => mockListCachedTasks(...a),
  getCachedTaskById: (...a: unknown[]) => mockGetCachedTaskById(...a),
}));
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: unknown[]) => mockTrack(...a),
}));
jest.mock("@/lib/db", () => ({
  safeQuery: (...a: unknown[]) => mockSafeQuery(...a),
  query: (...a: unknown[]) => mockSafeQuery(...a),
}));

import { NextRequest } from "next/server";
import { POST } from "../route";
import { PATCH } from "../[id]/route";

function req(path: string, body: unknown, method: "POST" | "PATCH" = "POST"): NextRequest {
  return new NextRequest(`https://x.test${path}`, {
    method,
    headers: { authorization: "Bearer test", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const USER = { id: "u1", role: "member" };

beforeEach(() => {
  jest.clearAllMocks();
  mockTrack.mockResolvedValue(undefined);
  mockGetUser.mockReturnValue(USER);
  mockResolveDefaultListId.mockResolvedValue("ms-list-default");
});

describe("POST /api/tasks", () => {
  it("401 when unauthenticated", async () => {
    mockGetUser.mockReturnValue(null);
    const res = await POST(req("/api/tasks", { title: "x" }));
    expect(res.status).toBe(401);
    expect(mockCreateTask).not.toHaveBeenCalled();
  });

  it("400 when title missing", async () => {
    const res = await POST(req("/api/tasks", { dueAt: null }));
    expect(res.status).toBe(400);
  });

  it("400 on an invalid reminderAt", async () => {
    const res = await POST(req("/api/tasks", { title: "x", reminderAt: "not-a-date" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/reminderAt/);
    expect(mockCreateTask).not.toHaveBeenCalled();
  });

  it("400 when categories is not an array of strings", async () => {
    const res = await POST(req("/api/tasks", { title: "x", categories: [1, 2] }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/categories/);
  });

  it("201 and passes the enriched Outlook fields to the integration", async () => {
    mockCreateTask.mockResolvedValue({ id: "local-1", msTaskId: "ms-1", title: "Ship it" });
    const reminder = "2026-08-01T15:00:00.000Z";
    const start = "2026-07-20T00:00:00.000Z";
    const res = await POST(req("/api/tasks", {
      title: "Ship it",
      startAt: start,
      reminderAt: reminder,
      isReminderOn: true,
      categories: ["Client", "Urgent"],
      importance: "high",
    }));
    expect(res.status).toBe(201);
    expect(mockCreateTask).toHaveBeenCalledWith(
      "u1",
      "ms-list-default",
      expect.objectContaining({
        title: "Ship it",
        startAt: start,
        reminderAt: reminder,
        isReminderOn: true,
        categories: ["Client", "Urgent"],
        importance: "high",
      }),
    );
  });
});

describe("PATCH /api/tasks/[id]", () => {
  const ctx = { params: Promise.resolve({ id: "local-1" }) };

  it("401 when unauthenticated", async () => {
    mockGetUser.mockReturnValue(null);
    const res = await PATCH(req("/api/tasks/local-1", { title: "x" }, "PATCH"), ctx);
    expect(res.status).toBe(401);
  });

  it("404 when the task is not cached", async () => {
    mockGetCachedTaskById.mockResolvedValue(null);
    const res = await PATCH(req("/api/tasks/local-1", { title: "x" }, "PATCH"), ctx);
    expect(res.status).toBe(404);
  });

  it("400 on invalid startAt", async () => {
    mockGetCachedTaskById.mockResolvedValue({ id: "local-1", listId: "list-1", msTaskId: "ms-1" });
    const res = await PATCH(req("/api/tasks/local-1", { startAt: "nope" }, "PATCH"), ctx);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/startAt/);
  });

  it("200 and forwards reminder + categories to updateTask", async () => {
    mockGetCachedTaskById.mockResolvedValue({ id: "local-1", listId: "list-1", msTaskId: "ms-1" });
    mockSafeQuery.mockResolvedValue({ rows: [{ ms_list_id: "ms-list-1" }] });
    mockUpdateTask.mockResolvedValue({ id: "local-1", msTaskId: "ms-1", title: "x" });
    const res = await PATCH(
      req("/api/tasks/local-1", { reminderAt: "2026-08-01T15:00:00.000Z", categories: ["A"] }, "PATCH"),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(mockUpdateTask).toHaveBeenCalledWith(
      "u1",
      "ms-list-1",
      "ms-1",
      expect.objectContaining({ reminderAt: "2026-08-01T15:00:00.000Z", categories: ["A"] }),
    );
  });
});
