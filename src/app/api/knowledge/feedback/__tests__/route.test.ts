/**
 * POST /api/knowledge/feedback contract tests.
 */

const mockRequireCapability = jest.fn();
jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: (...args: unknown[]) => mockRequireCapability(...args),
}));

const mockRecordFeedback = jest.fn();
jest.mock("@/lib/knowledge/qa-cache", () => ({
  recordFeedback: (...args: unknown[]) => mockRecordFeedback(...args),
}));

const mockTrackEvent = jest.fn();
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...args: unknown[]) => mockTrackEvent(...args),
}));

import { NextRequest, NextResponse } from "next/server";
import { POST } from "@/app/api/knowledge/feedback/route";

function req(body: unknown): NextRequest {
  return new NextRequest("http://test/api/knowledge/feedback", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function allow() {
  mockRequireCapability.mockResolvedValueOnce({
    ok: true,
    user: { id: "u1", email: "u@t", name: "U", role: "dev", created_at: "" },
    capabilities: new Set<string>(),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("POST /api/knowledge/feedback", () => {
  it("401 when unauthenticated", async () => {
    mockRequireCapability.mockResolvedValueOnce({
      ok: false,
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    });
    const res = await POST(req({ qa_id: "q1", helpful: true }));
    expect(res.status).toBe(401);
  });

  it("400 when qa_id is missing", async () => {
    allow();
    const res = await POST(req({ helpful: true }));
    expect(res.status).toBe(400);
  });

  it("400 when helpful is not a boolean", async () => {
    allow();
    const res = await POST(req({ qa_id: "q1", helpful: "yes" }));
    expect(res.status).toBe(400);
  });

  it("200 + qa_feedback event on success", async () => {
    allow();
    mockRecordFeedback.mockResolvedValueOnce(undefined);
    const res = await POST(req({ qa_id: "q1", helpful: true }));
    expect(res.status).toBe(200);
    expect(mockRecordFeedback).toHaveBeenCalledWith("q1", true);
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "knowledge.qa_feedback",
      "u1",
      "dev",
      expect.objectContaining({ qa_id: "q1", helpful: true }),
    );
  });

  it("emits support_query with fell_back_to_ticket when set", async () => {
    allow();
    mockRecordFeedback.mockResolvedValueOnce(undefined);
    const res = await POST(
      req({
        qa_id: "q2",
        helpful: false,
        surface: "assistant_support",
        fell_back_to_ticket: true,
      }),
    );
    expect(res.status).toBe(200);
    const supportEvent = mockTrackEvent.mock.calls.find(
      (c) => c[0] === "assistant.support_query",
    );
    expect(supportEvent).toBeDefined();
    expect(supportEvent?.[3]).toEqual(
      expect.objectContaining({ fell_back_to_ticket: true }),
    );
  });

  it("500 when DB write throws", async () => {
    allow();
    mockRecordFeedback.mockRejectedValueOnce(new Error("db down"));
    const res = await POST(req({ qa_id: "q1", helpful: true }));
    expect(res.status).toBe(500);
  });
});
