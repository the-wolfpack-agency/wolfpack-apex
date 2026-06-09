/**
 * Contract tests for /api/surveys (GET list + POST create).
 * Asserts 200/201/400/401 and that survey.created fires + an audit row is
 * written. A schema that fails validateSchema (createSurvey throws) must
 * return 400, never 201.
 */

const mockCreateSurvey = jest.fn();
const mockListSurveys = jest.fn();
const mockTrackEvent = jest.fn();
const mockRecordAudit = jest.fn().mockResolvedValue({ id: "a", seq: 1, entryHash: "h" });
let authUser: { id: string; role: string; name: string; email: string } | null = {
  id: "u1",
  role: "ceo",
  name: "Nick",
  email: "n@x.co",
};

jest.mock("@/lib/surveys/store", () => ({
  createSurvey: (...a: any[]) => mockCreateSurvey(...a),
  listSurveys: (...a: any[]) => mockListSurveys(...a),
}));
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: any[]) => mockTrackEvent(...a),
}));
jest.mock("@/lib/audit-log", () => ({
  recordAudit: (...a: any[]) => mockRecordAudit(...a),
}));
jest.mock("@/lib/auth", () => ({
  getUserFromRequest: () => authUser,
}));

import { NextRequest } from "next/server";
import { GET, POST } from "../route";

const sampleSurvey = {
  id: "s1",
  slug: "abc1234",
  title: "NPS",
  description: null,
  schema: { questions: [{ id: "q", type: "rating", label: "Rate", required: true }] },
  status: "draft",
  qrCodeId: null,
  clientId: null,
  createdByUserId: "u1",
  createdByUserRole: "ceo",
  createdAt: "2026-06-09T00:00:00.000Z",
  updatedAt: "2026-06-09T00:00:00.000Z",
};

function postBody(body: unknown, auth = "Bearer x"): NextRequest {
  return new NextRequest("https://x.test/api/surveys", {
    method: "POST",
    headers: { authorization: auth, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  mockCreateSurvey.mockReset();
  mockListSurveys.mockReset();
  mockTrackEvent.mockReset();
  mockRecordAudit.mockClear();
  authUser = { id: "u1", role: "ceo", name: "Nick", email: "n@x.co" };
});

describe("GET /api/surveys", () => {
  test("401 when unauthenticated", async () => {
    authUser = null;
    const req = new NextRequest("https://x.test/api/surveys", {
      headers: { authorization: "" },
    });
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  test("200 returns surveys", async () => {
    mockListSurveys.mockResolvedValueOnce([sampleSurvey]);
    const req = new NextRequest("https://x.test/api/surveys", {
      headers: { authorization: "Bearer x" },
    });
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.surveys).toHaveLength(1);
    expect(body.surveys[0].slug).toBe("abc1234");
  });

  test("?mine=true scopes by userId", async () => {
    mockListSurveys.mockResolvedValueOnce([]);
    const req = new NextRequest("https://x.test/api/surveys?mine=true", {
      headers: { authorization: "Bearer x" },
    });
    await GET(req);
    expect(mockListSurveys).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "u1" }),
    );
  });
});

describe("POST /api/surveys", () => {
  test("401 when unauthenticated", async () => {
    authUser = null;
    const res = await POST(postBody({ title: "x", schema: {} }));
    expect(res.status).toBe(401);
  });

  test("400 when title missing", async () => {
    const res = await POST(postBody({ schema: {} }));
    expect(res.status).toBe(400);
    expect(mockCreateSurvey).not.toHaveBeenCalled();
  });

  test("201 happy path returns survey + fires survey.created + audits", async () => {
    mockCreateSurvey.mockResolvedValueOnce(sampleSurvey);
    const res = await POST(
      postBody({
        title: "NPS",
        schema: sampleSurvey.schema,
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.survey.slug).toBe("abc1234");
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "survey.created",
      "u1",
      "ceo",
      expect.objectContaining({ survey_id: "s1", slug: "abc1234" }),
    );
    expect(mockRecordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "survey.created", resourceType: "survey" }),
    );
  });

  test("400 when createSurvey throws a validation error (invalid/locked schema)", async () => {
    mockCreateSurvey.mockRejectedValueOnce(
      new Error("a survey needs at least one question"),
    );
    const res = await POST(postBody({ title: "Empty", schema: { questions: [] } }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/at least one question/);
    expect(mockTrackEvent).not.toHaveBeenCalled();
  });

  test("a valid custom slug is passed through to createSurvey", async () => {
    mockCreateSurvey.mockResolvedValueOnce(
      { ...sampleSurvey, slug: "weekend-porsche" },
    );
    const res = await POST(
      postBody({
        title: "NPS",
        schema: sampleSurvey.schema,
        slug: "weekend-porsche",
      }),
    );
    expect(res.status).toBe(201);
    expect(mockCreateSurvey).toHaveBeenCalledWith(
      expect.objectContaining({ slug: "weekend-porsche" }),
    );
  });

  test("409 slug_taken when the custom slug collides", async () => {
    mockCreateSurvey.mockRejectedValueOnce(new Error("slug_taken"));
    const res = await POST(
      postBody({ title: "NPS", schema: sampleSurvey.schema, slug: "weekend-porsche" }),
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("slug_taken");
    expect(mockTrackEvent).not.toHaveBeenCalled();
  });

  test("400 when the custom slug is invalid", async () => {
    mockCreateSurvey.mockRejectedValueOnce(
      new Error("Use lowercase letters, numbers and hyphens (3–50 chars)."),
    );
    const res = await POST(
      postBody({ title: "NPS", schema: sampleSurvey.schema, slug: "NOPE!" }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/lowercase letters/);
    expect(mockTrackEvent).not.toHaveBeenCalled();
  });
});
