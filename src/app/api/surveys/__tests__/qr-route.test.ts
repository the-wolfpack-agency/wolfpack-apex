/**
 * Contract tests for /api/surveys/[id]/qr (POST link-QR).
 * Asserts 401/404, the code points at /s/<slug> on the request origin,
 * survey.qr_linked fires + audits, the survey is patched with qrCodeId,
 * and a createCode failure returns 500.
 */

const mockGetSurveyById = jest.fn();
const mockUpdateSurvey = jest.fn();
const mockCreateCode = jest.fn();
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
}));
jest.mock("@/lib/qr/codes", () => ({
  createCode: (...a: any[]) => mockCreateCode(...a),
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
import { POST } from "../[id]/qr/route";

const SURVEY_ID = "s1";

function survey(overrides: Record<string, unknown> = {}) {
  return {
    id: SURVEY_ID,
    slug: "abc1234",
    title: "NPS",
    description: null,
    schema: { questions: [{ id: "q", type: "rating", label: "Rate", required: true }] },
    status: "published",
    qrCodeId: null,
    clientId: null,
    createdByUserId: "u1",
    createdByUserRole: "ceo",
    createdAt: "2026-06-09T00:00:00.000Z",
    updatedAt: "2026-06-09T00:00:00.000Z",
    ...overrides,
  };
}

const sampleCode = {
  id: "code-1",
  slug: "qr12345",
  targetUrl: "https://x.test/s/abc1234",
  label: "NPS",
};

function postReq(): NextRequest {
  return new NextRequest(`https://x.test/api/surveys/${SURVEY_ID}/qr`, {
    method: "POST",
    headers: { authorization: "Bearer x" },
  });
}
const ctx = { params: Promise.resolve({ id: SURVEY_ID }) };

beforeEach(() => {
  mockGetSurveyById.mockReset();
  mockUpdateSurvey.mockReset();
  mockCreateCode.mockReset();
  mockTrackEvent.mockReset();
  mockRecordAudit.mockClear();
  authUser = { id: "u1", role: "ceo", name: "Nick", email: "n@x.co" };
});

describe("POST /api/surveys/[id]/qr", () => {
  test("401 when unauthenticated", async () => {
    authUser = null;
    const res = await POST(postReq(), ctx);
    expect(res.status).toBe(401);
  });

  test("404 when survey missing", async () => {
    mockGetSurveyById.mockResolvedValueOnce(null);
    const res = await POST(postReq(), ctx);
    expect(res.status).toBe(404);
    expect(mockCreateCode).not.toHaveBeenCalled();
  });

  test("200 mints a code at /s/<slug>, links it, fires survey.qr_linked", async () => {
    mockGetSurveyById.mockResolvedValueOnce(survey());
    mockCreateCode.mockResolvedValueOnce(sampleCode);
    mockUpdateSurvey.mockResolvedValueOnce(survey({ qrCodeId: "code-1" }));

    const res = await POST(postReq(), ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.code.id).toBe("code-1");
    expect(body.survey.qrCodeId).toBe("code-1");

    expect(mockCreateCode).toHaveBeenCalledWith(
      expect.objectContaining({
        targetUrl: "https://x.test/s/abc1234",
        label: "NPS",
        userId: "u1",
        userRole: "ceo",
      }),
    );
    expect(mockUpdateSurvey).toHaveBeenCalledWith(SURVEY_ID, { qrCodeId: "code-1" });
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "survey.qr_linked",
      "u1",
      "ceo",
      expect.objectContaining({ survey_id: SURVEY_ID, qr_code_id: "code-1" }),
    );
    expect(mockRecordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "survey.qr_linked" }),
    );
  });

  test("500 when createCode throws", async () => {
    mockGetSurveyById.mockResolvedValueOnce(survey());
    mockCreateCode.mockRejectedValueOnce(new Error("DB down"));
    const res = await POST(postReq(), ctx);
    expect(res.status).toBe(500);
    expect(mockUpdateSurvey).not.toHaveBeenCalled();
  });
});
