/**
 * POST /api/discussions — notify_all fanout unit tests.
 *
 * Exercises the new branch in the POST handler: when the client sends
 * `notify_all: true`, the server reads instinct_team_members + calls
 * notify() once per active row + emits discussions.notify_all_fanout
 * with the recipient_count.
 */

const mockGetUserFromRequest = jest.fn();
jest.mock("@/lib/auth", () => ({
  getUserFromRequest: (...args: unknown[]) => mockGetUserFromRequest(...args),
}));

const mockGetThreads = jest.fn();
const mockCreateThread = jest.fn();
jest.mock("@/lib/discussions", () => ({
  getThreads: (...args: unknown[]) => mockGetThreads(...args),
  createThread: (...args: unknown[]) => mockCreateThread(...args),
}));

const mockNotify = jest.fn();
jest.mock("@/lib/notifications/in-app", () => ({
  notify: (...args: unknown[]) => mockNotify(...args),
}));

const mockTrackEvent = jest.fn();
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...args: unknown[]) => mockTrackEvent(...args),
}));

const mockSafeQuery = jest.fn();
jest.mock("@/lib/db", () => ({
  safeQuery: (...args: unknown[]) => mockSafeQuery(...args),
}));

import { NextRequest } from "next/server";
import { POST } from "@/app/api/discussions/route";

function req(body: unknown): NextRequest {
  return new NextRequest("http://test/api/discussions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const OWNER = {
  id: "u-owner",
  role: "dev",
  name: "Owner",
  email: "owner@example.com",
};

const NEW_THREAD = {
  id: "d-new",
  title: "Hello team",
  category: "general",
  created_by: "u-owner",
  status: "open",
  pinned: false,
  tags: [],
  created_at: "2026-04-23T00:00:00Z",
  updated_at: "2026-04-23T00:00:00Z",
  reply_count: 1,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockNotify.mockResolvedValue({ id: "n-1" });
  mockSafeQuery.mockResolvedValue({ rows: [] });
});

describe("POST /api/discussions", () => {
  it("401 without auth", async () => {
    mockGetUserFromRequest.mockReturnValueOnce(null);
    const res = await POST(
      req({ title: "t", category: "general", content: "c", notify_all: true }),
    );
    expect(res.status).toBe(401);
    expect(mockCreateThread).not.toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it("400 when required fields missing", async () => {
    mockGetUserFromRequest.mockReturnValueOnce(OWNER);
    const res = await POST(req({ title: "t" }));
    expect(res.status).toBe(400);
  });

  it("default path (notify_all absent) does NOT fan out or read team members", async () => {
    mockGetUserFromRequest.mockReturnValueOnce(OWNER);
    mockCreateThread.mockResolvedValueOnce(NEW_THREAD);
    const res = await POST(
      req({ title: "t", category: "general", content: "c" }),
    );
    expect(res.status).toBe(201);
    expect(mockSafeQuery).not.toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();
    expect(mockTrackEvent).not.toHaveBeenCalledWith(
      "discussions.notify_all_fanout",
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it("notify_all=true → notify() once per team member + fanout event", async () => {
    mockGetUserFromRequest.mockReturnValueOnce(OWNER);
    mockCreateThread.mockResolvedValueOnce(NEW_THREAD);
    mockSafeQuery.mockResolvedValueOnce({
      rows: [{ id: "u-1" }, { id: "u-2" }, { id: "u-3" }],
    });

    const res = await POST(
      req({
        title: "Hello team",
        category: "general",
        content: "c",
        notify_all: true,
      }),
    );
    expect(res.status).toBe(201);

    // safeQuery was called with the instinct_team_members filter.
    expect(mockSafeQuery).toHaveBeenCalledTimes(1);
    const [sql] = mockSafeQuery.mock.calls[0];
    expect(sql).toContain("instinct_team_members");
    expect(sql).toContain("is_active = true");

    // One notify() per recipient, with actionUrl pointing at /discussions#<id>.
    expect(mockNotify).toHaveBeenCalledTimes(3);
    for (const call of mockNotify.mock.calls) {
      const payload = call[0] as {
        actionUrl: string;
        sourceId: string;
        category: string;
        dedup: boolean;
        userId: string;
      };
      expect(payload.actionUrl).toBe("/discussions#d-new");
      expect(payload.sourceId).toBe("d-new");
      expect(payload.category).toBe("discussions");
      expect(payload.dedup).toBe(true);
      expect(["u-1", "u-2", "u-3"]).toContain(payload.userId);
    }

    // Analytics event fired with recipient_count matching successful notifies.
    const fanout = mockTrackEvent.mock.calls.find(
      (c) => c[0] === "discussions.notify_all_fanout",
    );
    expect(fanout).toBeDefined();
    expect(fanout![3]).toEqual(
      expect.objectContaining({
        discussion_id: "d-new",
        recipient_count: 3,
      }),
    );
  });

  it("notify_all skips rows whose notify() rejects but still emits fanout event", async () => {
    mockGetUserFromRequest.mockReturnValueOnce(OWNER);
    mockCreateThread.mockResolvedValueOnce(NEW_THREAD);
    mockSafeQuery.mockResolvedValueOnce({
      rows: [{ id: "u-1" }, { id: "u-2" }],
    });
    mockNotify
      .mockResolvedValueOnce({ id: "n-1" })
      .mockRejectedValueOnce(new Error("preferences read failed"));

    const res = await POST(
      req({
        title: "Hello team",
        category: "general",
        content: "c",
        notify_all: true,
      }),
    );
    expect(res.status).toBe(201);

    const fanout = mockTrackEvent.mock.calls.find(
      (c) => c[0] === "discussions.notify_all_fanout",
    );
    expect(fanout).toBeDefined();
    // Only 1 recipient succeeded — but the event still fires so the
    // learning loop can see the partial-fanout rate.
    expect(fanout![3]).toEqual(
      expect.objectContaining({
        discussion_id: "d-new",
        recipient_count: 1,
      }),
    );
  });
});
