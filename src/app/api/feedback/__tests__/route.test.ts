/**
 * Contract tests for POST /api/feedback.
 *
 * Asserts:
 *   - 401 when auth fails
 *   - 400 when message is missing / empty / oversized
 *   - 429 when the per-user rate limit (3/min) is exceeded
 *   - 201 + { id, recorded_at } on the happy path
 *   - 500 when the underlying recordUserFeedback throws
 *   - workflow_id is threaded through to the lib when provided
 */

const mockRequireCapability = jest.fn();
const mockRecordUserFeedback = jest.fn();

jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: (...a: unknown[]) => mockRequireCapability(...a),
}));
jest.mock("@/lib/feedback/record-feedback", () => ({
  recordUserFeedback: (...a: unknown[]) => mockRecordUserFeedback(...a),
  MAX_FEEDBACK_LENGTH: 2000,
}));

import { NextRequest } from "next/server";
import { POST, _resetRateLimit } from "@/app/api/feedback/route";

function makeReq(body: unknown): NextRequest {
  return new NextRequest("http://test/api/feedback", {
    method: "POST",
    headers: {
      authorization: "Bearer x",
      "content-type": "application/json",
      "user-agent": "jest-suite/1.0",
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function authOk(overrides: Partial<{ id: string; role: string; workspaceId: string; email: string }> = {}) {
  return {
    ok: true,
    user: {
      id: overrides.id ?? "00000000-0000-0000-0000-000000000010",
      role: overrides.role ?? "cto",
      email: overrides.email ?? "homyk@thewolfpack.agency",
      name: "Nick",
      workspaceId: overrides.workspaceId ?? "00000000-0000-0000-0000-000000000099",
      created_at: "",
    },
    capabilities: new Set(),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  _resetRateLimit();
});

describe("POST /api/feedback", () => {
  test("401 when auth fails", async () => {
    mockRequireCapability.mockResolvedValueOnce({
      ok: false,
      response: new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
      }),
    });
    const res = await POST(makeReq({ message: "hi" }));
    expect(res.status).toBe(401);
    expect(mockRecordUserFeedback).not.toHaveBeenCalled();
  });

  test("400 when JSON body is malformed", async () => {
    mockRequireCapability.mockResolvedValueOnce(authOk());
    const res = await POST(makeReq("not-json{{"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_input");
  });

  test("400 when message is missing or blank", async () => {
    mockRequireCapability.mockResolvedValue(authOk());
    for (const payload of [{}, { message: "" }, { message: "   " }, { message: 42 }]) {
      /* Reset between iterations so the rate limiter (3/min) doesn't
       * shadow the validation check on the 4th payload. Each branch is
       * independently exercising the same validator. */
      _resetRateLimit();
      const res = await POST(makeReq(payload));
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("invalid_input");
    }
    expect(mockRecordUserFeedback).not.toHaveBeenCalled();
  });

  test("400 when message exceeds the cap", async () => {
    mockRequireCapability.mockResolvedValueOnce(authOk());
    const res = await POST(makeReq({ message: "x".repeat(2001) }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.detail).toMatch(/exceeds 2000/);
    expect(mockRecordUserFeedback).not.toHaveBeenCalled();
  });

  test("201 + { id, recorded_at } on the happy path; passes user/workspace/surface/ua through to the lib", async () => {
    mockRequireCapability.mockResolvedValue(authOk());
    mockRecordUserFeedback.mockResolvedValueOnce({
      id: "fb-1",
      recordedAt: "2026-05-19T12:00:00.000Z",
    });
    const res = await POST(
      makeReq({
        message: "calendar widget is broken",
        surface: "/assistant",
        workflow_id: "00000000-0000-0000-0000-0000000000aa",
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toEqual({ id: "fb-1", recorded_at: "2026-05-19T12:00:00.000Z" });

    expect(mockRecordUserFeedback).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "00000000-0000-0000-0000-000000000099",
        userId: "00000000-0000-0000-0000-000000000010",
        userEmail: "homyk@thewolfpack.agency",
        userRole: "cto",
        message: "calendar widget is broken",
        surface: "/assistant",
        userAgent: "jest-suite/1.0",
        workflowId: "00000000-0000-0000-0000-0000000000aa",
      }),
    );
  });

  test("429 after the 4th call in the same minute (limit is 3)", async () => {
    mockRequireCapability.mockResolvedValue(authOk());
    mockRecordUserFeedback.mockResolvedValue({
      id: "fb-x",
      recordedAt: "2026-05-19T12:00:00.000Z",
    });
    for (let i = 0; i < 3; i++) {
      const ok = await POST(makeReq({ message: `note ${i}` }));
      expect(ok.status).toBe(201);
    }
    const blocked = await POST(makeReq({ message: "one too many" }));
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).not.toBeNull();
    const body = await blocked.json();
    expect(body.error).toBe("rate_limited");
    /* The 4th call must not have hit the lib. */
    expect(mockRecordUserFeedback).toHaveBeenCalledTimes(3);
  });

  test("500 when the lib throws (e.g. WriteQueryError)", async () => {
    mockRequireCapability.mockResolvedValueOnce(authOk());
    mockRecordUserFeedback.mockRejectedValueOnce(new Error("db is down"));
    const res = await POST(makeReq({ message: "hi" }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("internal");
  });
});
