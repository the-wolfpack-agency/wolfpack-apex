/**
 * Contract tests for /api/releases.
 *
 * Asserts the auth gate (200/401/403), input validation (400), and that the
 * learning + compliance hooks fire (analytics trackEvent + audit recordAudit).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { NextRequest } from "next/server";

const mockRequireCapability = jest.fn();
jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: (...a: unknown[]) => mockRequireCapability(...a),
}));

const mockTrackEvent = jest.fn();
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: unknown[]) => mockTrackEvent(...a) }));

const mockRecordAudit = jest.fn(async (..._a: unknown[]) => {});
jest.mock("@/lib/audit-log", () => ({ recordAudit: (...a: unknown[]) => mockRecordAudit(...a) }));

const mockListReleases = jest.fn();
const mockCreateRelease = jest.fn();
jest.mock("@/lib/releases", () => ({
  listReleases: (...a: unknown[]) => mockListReleases(...a),
  createRelease: (...a: unknown[]) => mockCreateRelease(...a),
}));

import { GET, POST } from "../route";
import { NextResponse } from "next/server";

const USER = { id: "u1", role: "cto" };

function authorize() {
  mockRequireCapability.mockResolvedValue({ ok: true, user: USER });
}
function deny(status: number) {
  mockRequireCapability.mockResolvedValue({
    ok: false,
    response: NextResponse.json({ error: "no" }, { status }),
  });
}

function req(method: string, body?: unknown): NextRequest {
  return new NextRequest("https://x.test/api/releases", {
    method,
    headers: { authorization: "Bearer x", "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("GET /api/releases", () => {
  test("200 returns releases and fires analytics", async () => {
    authorize();
    mockListReleases.mockResolvedValue([{ id: "r1", version: "2026-07-29", entries: [] }]);
    const res = await GET(req("GET"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.releases).toHaveLength(1);
    expect(mockTrackEvent).toHaveBeenCalledWith("releases.viewed", "u1", "cto", expect.any(Object));
  });

  test("401 when unauthorized", async () => {
    deny(401);
    const res = await GET(req("GET"));
    expect(res.status).toBe(401);
    expect(mockListReleases).not.toHaveBeenCalled();
  });
});

describe("POST /api/releases", () => {
  const VALID = {
    version: "2026-07-29",
    title: "Release",
    entries: [{ title: "Forgot-password fixed", description: "d", how_to_use: "h", category: "fix" }],
  };

  test("201 publishes, fires analytics + audit", async () => {
    authorize();
    mockCreateRelease.mockResolvedValue({ version: "2026-07-29", title: "Release", published: true, entries: VALID.entries });
    const res = await POST(req("POST", VALID));
    expect(res.status).toBe(201);
    expect(mockCreateRelease).toHaveBeenCalledTimes(1);
    expect(mockTrackEvent).toHaveBeenCalledWith("releases.published", "u1", "cto", expect.any(Object));
    expect(mockRecordAudit).toHaveBeenCalledTimes(1);
    const audited = mockRecordAudit.mock.calls[0][0] as any;
    expect(audited.action).toBe("releases.published");
    expect(audited.actor).toEqual({ user_id: "u1", role: "cto" });
  });

  test("403 when lacking releases.manage", async () => {
    deny(403);
    const res = await POST(req("POST", VALID));
    expect(res.status).toBe(403);
    expect(mockCreateRelease).not.toHaveBeenCalled();
  });

  test("400 when version/title missing", async () => {
    authorize();
    const res = await POST(req("POST", { entries: [] }));
    expect(res.status).toBe(400);
    expect(mockCreateRelease).not.toHaveBeenCalled();
  });

  test("400 when entries is not an array", async () => {
    authorize();
    const res = await POST(req("POST", { version: "v", title: "t", entries: "nope" }));
    expect(res.status).toBe(400);
  });

  test("drops entries without a title before persisting", async () => {
    authorize();
    mockCreateRelease.mockResolvedValue({ version: "v", title: "t", published: true, entries: [] });
    await POST(req("POST", { version: "v", title: "t", entries: [{ description: "no title" }, { title: "keep" }] }));
    const passed = mockCreateRelease.mock.calls[0][0] as any;
    expect(passed.entries).toHaveLength(1);
    expect(passed.entries[0].title).toBe("keep");
  });
});
