/**
 * Contract tests for /api/surveys/[id] (GET / PATCH / DELETE).
 * Asserts 200/400/401/404, the right analytics event per status transition
 * (published/closed/updated), survey.deleted on delete, and audit rows.
 */

const mockGetSurveyById = jest.fn();
const mockUpdateSurvey = jest.fn();
const mockDeleteSurvey = jest.fn();
const mockTrackEvent = jest.fn();
const mockRecordAudit = jest.fn().mockResolvedValue({ id: "a", seq: 1, entryHash: "h" });
let authUser: { id: string; role: string; name: string; email: string } | null = {
  id: "u1",
  role: "ceo",
  name: "Nick",
  email: "n@x.co",
};

jest.mock("@/lib/surveys/store", () => ({
  getSurveyById: (...a: any[]) => mockGetSurveyById(...a),
  updateSurvey: (...a: any[]) => mockUpdateSurvey(...a),
  deleteSurvey: (...a: any[]) => mockDeleteSurvey(...a),
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
import { GET, PATCH, DELETE } from "../[id]/route";

const SURVEY_ID = "s1";

function survey(overrides: Record<string, unknown> = {}) {
  return {
    id: SURVEY_ID,
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
    ...overrides,
  };
}

function patchReq(body: unknown): NextRequest {
  return new NextRequest(`https://x.test/api/surveys/${SURVEY_ID}`, {
    method: "PATCH",
    headers: { authorization: "Bearer x", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
function getReq(): NextRequest {
  return new NextRequest(`https://x.test/api/surveys/${SURVEY_ID}`, {
    headers: { authorization: "Bearer x" },
  });
}
function deleteReq(): NextRequest {
  return new NextRequest(`https://x.test/api/surveys/${SURVEY_ID}`, {
    method: "DELETE",
    headers: { authorization: "Bearer x" },
  });
}
const ctx = { params: Promise.resolve({ id: SURVEY_ID }) };

beforeEach(() => {
  mockGetSurveyById.mockReset();
  mockUpdateSurvey.mockReset();
  mockDeleteSurvey.mockReset();
  mockTrackEvent.mockReset();
  mockRecordAudit.mockClear();
  authUser = { id: "u1", role: "ceo", name: "Nick", email: "n@x.co" };
});

describe("GET /api/surveys/[id]", () => {
  test("401 when unauthenticated", async () => {
    authUser = null;
    const res = await GET(getReq(), ctx);
    expect(res.status).toBe(401);
  });

  test("404 when missing", async () => {
    mockGetSurveyById.mockResolvedValueOnce(null);
    const res = await GET(getReq(), ctx);
    expect(res.status).toBe(404);
  });

  test("200 returns the survey", async () => {
    mockGetSurveyById.mockResolvedValueOnce(survey());
    const res = await GET(getReq(), ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.survey.id).toBe(SURVEY_ID);
  });
});

describe("PATCH /api/surveys/[id]", () => {
  test("401 when unauthenticated", async () => {
    authUser = null;
    const res = await PATCH(patchReq({ title: "x" }), ctx);
    expect(res.status).toBe(401);
  });

  test("404 when missing", async () => {
    mockGetSurveyById.mockResolvedValueOnce(null);
    const res = await PATCH(patchReq({ title: "x" }), ctx);
    expect(res.status).toBe(404);
    expect(mockUpdateSurvey).not.toHaveBeenCalled();
  });

  test("400 on empty patch", async () => {
    mockGetSurveyById.mockResolvedValueOnce(survey());
    const res = await PATCH(patchReq({}), ctx);
    expect(res.status).toBe(400);
  });

  test("400 when updateSurvey throws a validation error", async () => {
    mockGetSurveyById.mockResolvedValueOnce(survey());
    mockUpdateSurvey.mockRejectedValueOnce(new Error("unknown question type: essay"));
    const res = await PATCH(patchReq({ schema: { questions: [] } }), ctx);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/unknown question type/);
  });

  test("title-only update fires survey.updated", async () => {
    mockGetSurveyById.mockResolvedValueOnce(survey());
    mockUpdateSurvey.mockResolvedValueOnce(survey({ title: "Renamed" }));
    const res = await PATCH(patchReq({ title: "Renamed" }), ctx);
    expect(res.status).toBe(200);
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "survey.updated",
      "u1",
      "ceo",
      expect.objectContaining({ survey_id: SURVEY_ID }),
    );
  });

  test("status→published fires survey.published", async () => {
    mockGetSurveyById.mockResolvedValueOnce(survey({ status: "draft" }));
    mockUpdateSurvey.mockResolvedValueOnce(survey({ status: "published" }));
    const res = await PATCH(patchReq({ status: "published" }), ctx);
    expect(res.status).toBe(200);
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "survey.published",
      "u1",
      "ceo",
      expect.objectContaining({ status: "published" }),
    );
    expect(mockRecordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "survey.published" }),
    );
  });

  test("status→closed fires survey.closed", async () => {
    mockGetSurveyById.mockResolvedValueOnce(survey({ status: "published" }));
    mockUpdateSurvey.mockResolvedValueOnce(survey({ status: "closed" }));
    const res = await PATCH(patchReq({ status: "closed" }), ctx);
    expect(res.status).toBe(200);
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "survey.closed",
      "u1",
      "ceo",
      expect.objectContaining({ status: "closed" }),
    );
  });

  test("a valid custom slug is included in the updateSurvey patch", async () => {
    mockGetSurveyById.mockResolvedValueOnce(survey());
    mockUpdateSurvey.mockResolvedValueOnce(survey({ slug: "weekend-porsche" }));
    const res = await PATCH(patchReq({ slug: "weekend-porsche" }), ctx);
    expect(res.status).toBe(200);
    expect(mockUpdateSurvey).toHaveBeenCalledWith(
      SURVEY_ID,
      expect.objectContaining({ slug: "weekend-porsche" }),
    );
  });

  test("409 slug_taken when the custom slug collides", async () => {
    mockGetSurveyById.mockResolvedValueOnce(survey());
    mockUpdateSurvey.mockRejectedValueOnce(new Error("slug_taken"));
    const res = await PATCH(patchReq({ slug: "weekend-porsche" }), ctx);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("slug_taken");
  });

  test("400 when the custom slug is invalid", async () => {
    mockGetSurveyById.mockResolvedValueOnce(survey());
    mockUpdateSurvey.mockRejectedValueOnce(
      new Error("Use lowercase letters, numbers and hyphens (3–50 chars)."),
    );
    const res = await PATCH(patchReq({ slug: "NOPE!" }), ctx);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/lowercase letters/);
  });
});

describe("DELETE /api/surveys/[id]", () => {
  test("401 when unauthenticated", async () => {
    authUser = null;
    const res = await DELETE(deleteReq(), ctx);
    expect(res.status).toBe(401);
  });

  test("404 when missing", async () => {
    mockGetSurveyById.mockResolvedValueOnce(null);
    const res = await DELETE(deleteReq(), ctx);
    expect(res.status).toBe(404);
    expect(mockDeleteSurvey).not.toHaveBeenCalled();
  });

  test("200 deletes, fires survey.deleted + audits", async () => {
    mockGetSurveyById.mockResolvedValueOnce(survey());
    mockDeleteSurvey.mockResolvedValueOnce(undefined);
    const res = await DELETE(deleteReq(), ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(mockDeleteSurvey).toHaveBeenCalledWith(SURVEY_ID);
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "survey.deleted",
      "u1",
      "ceo",
      expect.objectContaining({ survey_id: SURVEY_ID }),
    );
    expect(mockRecordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "survey.deleted" }),
    );
  });
});
