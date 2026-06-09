/**
 * Contract tests for /api/surveys/[id]/responses (JSON + CSV).
 * Asserts 401/404, the JSON { count, aggregate, responses } shape, and that
 * ?format=csv returns text/csv with a label header + one row per response
 * (incl. CSV-escaping of a comma-bearing answer).
 */

const mockGetSurveyById = jest.fn();
const mockListResponses = jest.fn();
let authUser: { id: string; role: string; name: string; email: string } | null = {
  id: "u1",
  role: "ceo",
  name: "Nick",
  email: "n@x.co",
};

jest.mock("@/lib/surveys/store", () => ({
  getSurveyById: (...a: any[]) => mockGetSurveyById(...a),
  listResponses: (...a: any[]) => mockListResponses(...a),
}));
jest.mock("@/lib/auth", () => ({
  getUserFromRequest: () => authUser,
}));

import { NextRequest } from "next/server";
import { GET } from "../[id]/responses/route";

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
      submittedAt: "2026-06-09T01:00:00.000Z",
    },
    {
      id: "r2",
      surveyId: SURVEY_ID,
      answers: { name: 'Ann, "the boss"', score: 3 },
      respondentFingerprint: null,
      qrScanId: null,
      submittedAt: "2026-06-09T02:00:00.000Z",
    },
  ];
}

function jsonReq(qs = ""): NextRequest {
  return new NextRequest(`https://x.test/api/surveys/${SURVEY_ID}/responses${qs}`, {
    headers: { authorization: "Bearer x" },
  });
}
const ctx = { params: Promise.resolve({ id: SURVEY_ID }) };

beforeEach(() => {
  mockGetSurveyById.mockReset();
  mockListResponses.mockReset();
  authUser = { id: "u1", role: "ceo", name: "Nick", email: "n@x.co" };
});

describe("GET /api/surveys/[id]/responses", () => {
  test("401 when unauthenticated", async () => {
    authUser = null;
    const res = await GET(jsonReq(), ctx);
    expect(res.status).toBe(401);
  });

  test("404 when survey missing", async () => {
    mockGetSurveyById.mockResolvedValueOnce(null);
    const res = await GET(jsonReq(), ctx);
    expect(res.status).toBe(404);
  });

  test("200 JSON returns count, aggregate, responses", async () => {
    mockGetSurveyById.mockResolvedValueOnce(survey());
    mockListResponses.mockResolvedValueOnce(responsesFixture());
    const res = await GET(jsonReq(), ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(2);
    expect(body.responses).toHaveLength(2);
    const byId = Object.fromEntries(
      body.aggregate.map((a: any) => [a.questionId, a]),
    );
    expect(byId.langs.optionCounts).toEqual({ en: 1, es: 1 });
    expect(byId.score.average).toBe(4); // (5+3)/2
  });

  test("200 CSV returns text/csv with label header + escaped rows", async () => {
    mockGetSurveyById.mockResolvedValueOnce(survey());
    mockListResponses.mockResolvedValueOnce(responsesFixture());
    const res = await GET(jsonReq("?format=csv"), ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/csv/);
    const text = await res.text();
    const lines = text.split("\r\n");
    // header: submitted_at + the three labels (one quoted for the comma)
    expect(lines[0]).toBe('submitted_at,Your name,Languages,"Rate, please"');
    // first data row: multi-select joined with "; "
    expect(lines[1]).toContain("Nick");
    expect(lines[1]).toContain("en; es");
    // second row: a comma+quote answer must be CSV-escaped
    expect(lines[2]).toContain('"Ann, ""the boss"""');
    expect(lines).toHaveLength(3);
  });
});
