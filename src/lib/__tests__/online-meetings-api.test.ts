/**
 * /api/online-meetings + /api/online-meetings/[id] route tests.
 */
 

export {};

const mockGetUserOMA = jest.fn();
jest.mock("@/lib/auth", () => ({
  getUserFromRequest: (...args: unknown[]) => mockGetUserOMA(...args),
}));

const mockCreateMeetingOMA = jest.fn();
const mockUpdateMeetingOMA = jest.fn();
const mockGetMeetingOMA = jest.fn();

jest.mock("@/lib/integrations/microsoft-online-meetings", () => ({
  createMeeting: (...args: unknown[]) => mockCreateMeetingOMA(...args),
  updateMeeting: (...args: unknown[]) => mockUpdateMeetingOMA(...args),
  getMeeting: (...args: unknown[]) => mockGetMeetingOMA(...args),
}));

jest.mock("@/lib/db", () => ({
  safeQuery: jest.fn(),
  query: jest.fn(),
}));

import { POST as createPOST } from "@/app/api/online-meetings/route";
import {
  GET as meetingGET,
  PATCH as meetingPATCH,
} from "@/app/api/online-meetings/[id]/route";

function mkReq(auth?: string, body?: any): any {
  return {
    headers: {
      get: (k: string) =>
        k.toLowerCase() === "authorization" ? auth ?? null : null,
    },
    json: () =>
      body === undefined
        ? Promise.reject(new Error("no body"))
        : Promise.resolve(body),
    url: "http://localhost/x",
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetUserOMA.mockReturnValue({ id: "u-1", role: "admin" });
});

// ---------------------------------------------------------------------------
// POST /api/online-meetings
// ---------------------------------------------------------------------------

describe("POST /api/online-meetings", () => {
  it("401s with no auth", async () => {
    mockGetUserOMA.mockReturnValueOnce(null);
    const res = await createPOST(mkReq(undefined, {}));
    expect(res.status).toBe(401);
  });

  it("400s on invalid JSON body", async () => {
    const res = await createPOST(mkReq("Bearer x", undefined));
    expect(res.status).toBe(400);
  });

  it("400s on invalid_input from integration", async () => {
    mockCreateMeetingOMA.mockResolvedValueOnce({
      ok: false,
      code: "invalid_input",
      message: "subject_required",
    });
    const res = await createPOST(
      mkReq("Bearer x", {
        subject: "",
        startAt: "2026-04-01T10:00:00Z",
        endAt: "2026-04-01T11:00:00Z",
      }),
    );
    expect(res.status).toBe(400);
  });

  it("403s on scope_missing", async () => {
    mockCreateMeetingOMA.mockResolvedValueOnce({
      ok: false,
      code: "scope_missing",
      scope: "OnlineMeetings.ReadWrite.All",
    });
    const res = await createPOST(
      mkReq("Bearer x", {
        subject: "x",
        startAt: "2026-04-01T10:00:00Z",
        endAt: "2026-04-01T11:00:00Z",
      }),
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("scope_missing");
  });

  it("201s on success and returns id + joinWebUrl", async () => {
    mockCreateMeetingOMA.mockResolvedValueOnce({
      ok: true,
      value: {
        id: "m-1",
        joinWebUrl: "https://teams/x",
        conferenceId: "1",
      },
    });
    const res = await createPOST(
      mkReq("Bearer x", {
        subject: "x",
        startAt: "2026-04-01T10:00:00Z",
        endAt: "2026-04-01T11:00:00Z",
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ id: "m-1", joinWebUrl: "https://teams/x" });
  });

  it("429s on rate_limited with Retry-After", async () => {
    mockCreateMeetingOMA.mockResolvedValueOnce({
      ok: false,
      code: "rate_limited",
      retryAfter: 15,
    });
    const res = await createPOST(
      mkReq("Bearer x", {
        subject: "x",
        startAt: "2026-04-01T10:00:00Z",
        endAt: "2026-04-01T11:00:00Z",
      }),
    );
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("15");
  });
});

// ---------------------------------------------------------------------------
// GET /api/online-meetings/[id]
// ---------------------------------------------------------------------------

describe("GET /api/online-meetings/[id]", () => {
  it("404s on missing meeting", async () => {
    mockGetMeetingOMA.mockResolvedValueOnce(null);
    const res = await meetingGET(mkReq("Bearer x"), { params: Promise.resolve({ id: "m-1" }) });
    expect(res.status).toBe(404);
  });

  it("returns meeting on success", async () => {
    mockGetMeetingOMA.mockResolvedValueOnce({
      id: "local-1",
      msMeetingId: "m-1",
      subject: "Kickoff",
    });
    const res = await meetingGET(mkReq("Bearer x"), { params: Promise.resolve({ id: "m-1" }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.meeting.msMeetingId).toBe("m-1");
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/online-meetings/[id]
// ---------------------------------------------------------------------------

describe("PATCH /api/online-meetings/[id]", () => {
  it("401s without auth", async () => {
    mockGetUserOMA.mockReturnValueOnce(null);
    const res = await meetingPATCH(mkReq(undefined, { subject: "x" }), {
      params: Promise.resolve({ id: "m-1" }),
    });
    expect(res.status).toBe(401);
  });

  it("forwards typed fields only (ignores unknown)", async () => {
    mockUpdateMeetingOMA.mockResolvedValueOnce({
      ok: true,
      value: { id: "m-1" },
    });
    await meetingPATCH(
      mkReq("Bearer x", {
        subject: "Renamed",
        startAt: "2026-04-01T10:00:00Z",
        gibberish: 123,
      }),
      { params: Promise.resolve({ id: "m-1" }) },
    );
    const patchArg = mockUpdateMeetingOMA.mock.calls[0][2] as any;
    expect(patchArg).toEqual({
      subject: "Renamed",
      startAt: "2026-04-01T10:00:00Z",
    });
  });

  it("502s on graph_error", async () => {
    mockUpdateMeetingOMA.mockResolvedValueOnce({
      ok: false,
      code: "graph_error",
      status: 500,
      message: "bad",
    });
    const res = await meetingPATCH(
      mkReq("Bearer x", { subject: "x" }),
      { params: Promise.resolve({ id: "m-1" }) },
    );
    expect(res.status).toBe(502);
  });
});
