/**
 * Contract tests for /api/surveys/[id]/insights.
 *
 * Asserts 401 (unauthed), 404 (missing survey), and the 200 funnel shape:
 * { insights: { views, responses, completionRate, avgDurationMs,
 * firstResponseAt, lastResponseAt, byDevice, byCountry, byReferrer,
 * perQuestion } }. computeInsights runs for real over a small fixture so a
 * drift between the route's wiring and the funnel math is caught here.
 */

const mockGetSurveyById = jest.fn();
const mockCountSurveyViews = jest.fn();
const mockListResponses = jest.fn();
let authUser: { id: string; role: string; name: string; email: string } | null = {
  id: "u1",
  role: "ceo",
  name: "Nick",
  email: "n@x.co",
};

jest.mock("@/lib/surveys/store", () => ({
  getSurveyById: (...a: any[]) => mockGetSurveyById(...a),
  countSurveyViews: (...a: any[]) => mockCountSurveyViews(...a),
  listResponses: (...a: any[]) => mockListResponses(...a),
}));
jest.mock("@/lib/auth", () => ({
  getUserFromRequest: () => authUser,
}));

import { NextRequest } from "next/server";
import { GET } from "../insights/route";

const SURVEY_ID = "s1";
const schema = {
  questions: [
    { id: "name", type: "short_text", label: "Your name", required: true },
    {
      id: "langs",
      type: "multiple_choice",
      label: "Languages",
      required: false,
      options: ["en", "es"],
    },
    { id: "score", type: "rating", label: "Rate, please", required: false, max: 5 },
  ],
};

function survey(overrides: Record<string, unknown> = {}) {
  return {
    id: SURVEY_ID,
    slug: "abc1234",
    title: "NPS",
    description: null,
    schema,
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

function responsesFixture() {
  return [
    {
      id: "r1",
      surveyId: SURVEY_ID,
      answers: { name: "Nick", langs: ["en", "es"], score: 5 },
      respondentFingerprint: null,
      qrScanId: null,
      durationMs: 60000,
      device: "mobile",
      country: "US",
      referrer: "qr",
      submittedAt: "2026-06-09T01:00:00.000Z",
    },
    {
      id: "r2",
      surveyId: SURVEY_ID,
      answers: { name: "Ann", score: 3 },
      respondentFingerprint: null,
      qrScanId: null,
      durationMs: 40000,
      device: "desktop",
      country: "US",
      referrer: null,
      submittedAt: "2026-06-09T02:00:00.000Z",
    },
  ];
}

function jsonReq(): NextRequest {
  return new NextRequest(`https://x.test/api/surveys/${SURVEY_ID}/insights`, {
    headers: { authorization: "Bearer x" },
  });
}
const ctx = { params: Promise.resolve({ id: SURVEY_ID }) };

beforeEach(() => {
  mockGetSurveyById.mockReset();
  mockCountSurveyViews.mockReset();
  mockListResponses.mockReset();
  authUser = { id: "u1", role: "ceo", name: "Nick", email: "n@x.co" };
});

describe("GET /api/surveys/[id]/insights", () => {
  test("401 when unauthenticated", async () => {
    authUser = null;
    const res = await GET(jsonReq(), ctx);
    expect(res.status).toBe(401);
    // A missing survey lookup must never even run when unauthed.
    expect(mockGetSurveyById).not.toHaveBeenCalled();
  });

  test("404 when survey missing", async () => {
    mockGetSurveyById.mockResolvedValueOnce(null);
    const res = await GET(jsonReq(), ctx);
    expect(res.status).toBe(404);
  });

  test("200 returns the insights funnel shape", async () => {
    mockGetSurveyById.mockResolvedValueOnce(survey());
    mockCountSurveyViews.mockResolvedValueOnce(8);
    mockListResponses.mockResolvedValueOnce(responsesFixture());

    const res = await GET(jsonReq(), ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    const ins = body.insights;

    // Funnel core.
    expect(ins.views).toBe(8);
    expect(ins.responses).toBe(2);
    expect(ins.completionRate).toBe(0.25); // 2 / 8
    expect(ins.avgDurationMs).toBe(50000); // (60000 + 40000) / 2

    // Window.
    expect(ins.firstResponseAt).toBe("2026-06-09T01:00:00.000Z");
    expect(ins.lastResponseAt).toBe("2026-06-09T02:00:00.000Z");

    // Attribution breakdowns.
    expect(ins.byDevice).toEqual({ mobile: 1, desktop: 1 });
    expect(ins.byCountry).toEqual({ US: 2 });
    expect(ins.byReferrer).toEqual({ qr: 1, unknown: 1 });

    // Per-question aggregate carried through.
    expect(Array.isArray(ins.perQuestion)).toBe(true);
    const byId = Object.fromEntries(
      ins.perQuestion.map((q: any) => [q.questionId, q]),
    );
    expect(byId.langs.optionCounts).toEqual({ en: 1, es: 1 });
    expect(byId.score.average).toBe(4); // (5 + 3) / 2

    // The route fed the survey id into both the view count + response list.
    expect(mockCountSurveyViews).toHaveBeenCalledWith(SURVEY_ID);
    expect(mockListResponses).toHaveBeenCalledWith(SURVEY_ID);
  });

  test("completionRate is 0 when there are no views", async () => {
    mockGetSurveyById.mockResolvedValueOnce(survey());
    mockCountSurveyViews.mockResolvedValueOnce(0);
    mockListResponses.mockResolvedValueOnce([]);

    const res = await GET(jsonReq(), ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.insights.completionRate).toBe(0);
    expect(body.insights.avgDurationMs).toBeNull();
  });
});
