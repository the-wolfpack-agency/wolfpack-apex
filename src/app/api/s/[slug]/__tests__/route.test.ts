/**
 * Contract tests for the PUBLIC survey responder API (/api/s/[slug]).
 *
 * No auth on this surface — these assert the public contract:
 *   GET  → 404 on unpublished/missing, 200 with ONLY safe fields.
 *   POST → 400 on invalid answers (+ survey.response_rejected),
 *          200 on valid (+ survey.response_submitted + submitResponse),
 *          429 once the in-memory rate limit is exceeded.
 *
 * The store + analytics are mocked so no Postgres is touched.
 */

const mockGetPublished = jest.fn();
const mockSubmitResponse = jest.fn();
const mockTrackEvent = jest.fn();

jest.mock("@/lib/surveys/store", () => ({
  getPublishedSurveyBySlug: (...a: unknown[]) => mockGetPublished(...a),
  submitResponse: (...a: unknown[]) => mockSubmitResponse(...a),
}));
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: unknown[]) => mockTrackEvent(...a),
}));

import { NextRequest } from "next/server";
import { GET, POST, _resetRateLimit } from "../route";

const SCHEMA = {
  questions: [
    { id: "q1", type: "short_text", label: "Name", required: true },
    {
      id: "q2",
      type: "single_choice",
      label: "Plan",
      required: false,
      options: ["a", "b"],
    },
    { id: "q3", type: "rating", label: "Score", required: false, max: 5 },
  ],
};

const PUBLISHED_SURVEY = {
  id: "survey-1",
  slug: "abc1234",
  title: "Test survey",
  description: "How are we doing?",
  schema: SCHEMA,
  status: "published",
  qrCodeId: null,
  clientId: "client-secret",
  createdByUserId: "owner-secret",
  createdByUserRole: "admin",
  createdAt: "2026-06-09T00:00:00.000Z",
  updatedAt: "2026-06-09T00:00:00.000Z",
};

function ctx(slug: string) {
  return { params: Promise.resolve({ slug }) };
}

function getReq(): NextRequest {
  return new NextRequest("https://x.test/api/s/abc1234");
}

function postReq(
  body: unknown,
  ip = "1.2.3.4",
  extraHeaders: Record<string, string> = {},
): NextRequest {
  return new NextRequest("https://x.test/api/s/abc1234", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": ip,
      "user-agent": "jest",
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  mockGetPublished.mockReset();
  mockSubmitResponse.mockReset();
  mockTrackEvent.mockReset();
  _resetRateLimit();
});

describe("GET /api/s/[slug]", () => {
  test("404 when survey is missing / unpublished", async () => {
    mockGetPublished.mockResolvedValue(null);
    const res = await GET(getReq(), ctx("nope"));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  test("200 returns only safe fields (no owner/status/ids/client)", async () => {
    mockGetPublished.mockResolvedValue(PUBLISHED_SURVEY);
    const res = await GET(getReq(), ctx("abc1234"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.survey).toEqual({
      slug: "abc1234",
      title: "Test survey",
      description: "How are we doing?",
      schema: SCHEMA,
    });
    // Must NOT leak internals.
    expect(body.survey.id).toBeUndefined();
    expect(body.survey.status).toBeUndefined();
    expect(body.survey.clientId).toBeUndefined();
    expect(body.survey.createdByUserId).toBeUndefined();
  });
});

describe("POST /api/s/[slug]", () => {
  test("404 when survey is missing / unpublished", async () => {
    mockGetPublished.mockResolvedValue(null);
    const res = await POST(postReq({ answers: { q1: "x" } }), ctx("nope"));
    expect(res.status).toBe(404);
    expect(mockSubmitResponse).not.toHaveBeenCalled();
  });

  test("400 on invalid answers, fires survey.response_rejected", async () => {
    mockGetPublished.mockResolvedValue(PUBLISHED_SURVEY);
    // q1 required but missing.
    const res = await POST(postReq({ answers: { q3: 3 } }), ctx("abc1234"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(typeof body.error).toBe("string");
    expect(mockSubmitResponse).not.toHaveBeenCalled();
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "survey.response_rejected",
      "public",
      "public",
      expect.objectContaining({ survey_id: "survey-1", slug: "abc1234" }),
    );
  });

  test("200 on valid answers, persists + fires survey.response_submitted", async () => {
    mockGetPublished.mockResolvedValue(PUBLISHED_SURVEY);
    mockSubmitResponse.mockResolvedValue({ id: "resp-1" });
    const res = await POST(
      postReq({ answers: { q1: "Nick", q2: "a", q3: 4 } }),
      ctx("abc1234"),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, id: "resp-1" });
    expect(mockSubmitResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        surveyId: "survey-1",
        answers: { q1: "Nick", q2: "a", q3: 4 },
        respondentFingerprint: expect.any(String),
      }),
    );
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "survey.response_submitted",
      "public",
      "public",
      expect.objectContaining({ survey_id: "survey-1", slug: "abc1234" }),
    );
  });

  test("submit passes durationMs + server-derived device/country/referrer into submitResponse", async () => {
    mockGetPublished.mockResolvedValue(PUBLISHED_SURVEY);
    mockSubmitResponse.mockResolvedValue({ id: "resp-d" });

    const res = await POST(
      postReq({ answers: { q1: "Nick" }, durationMs: 4321 }, "2.2.2.2", {
        // iPhone UA → device "mobile"; edge country header → "US".
        "user-agent":
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Mobile/15E148",
        "x-vercel-ip-country": "US",
        referer: "https://t.co/x",
      }),
      ctx("abc1234"),
    );

    expect(res.status).toBe(200);
    expect(mockSubmitResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        surveyId: "survey-1",
        answers: { q1: "Nick" },
        durationMs: 4321,
        device: "mobile",
        country: "US",
        referrer: "https://t.co/x",
      }),
    );
  });

  test("a non-numeric / negative durationMs is sanitised to null", async () => {
    mockGetPublished.mockResolvedValue(PUBLISHED_SURVEY);
    mockSubmitResponse.mockResolvedValue({ id: "resp-n" });

    await POST(
      postReq({ answers: { q1: "x" }, durationMs: -5 }, "3.3.3.3"),
      ctx("abc1234"),
    );
    expect(mockSubmitResponse).toHaveBeenLastCalledWith(
      expect.objectContaining({ durationMs: null }),
    );

    await POST(
      postReq({ answers: { q1: "x" }, durationMs: "nope" }, "3.3.3.4"),
      ctx("abc1234"),
    );
    expect(mockSubmitResponse).toHaveBeenLastCalledWith(
      expect.objectContaining({ durationMs: null }),
    );
  });

  test("429 after exceeding the rate limit (5 / 10 min per ip-hash)", async () => {
    mockGetPublished.mockResolvedValue(PUBLISHED_SURVEY);
    mockSubmitResponse.mockResolvedValue({ id: "resp-x" });
    // 5 allowed submissions from the same ip.
    for (let i = 0; i < 5; i += 1) {
      const ok = await POST(
        postReq({ answers: { q1: "Nick" } }, "9.9.9.9"),
        ctx("abc1234"),
      );
      expect(ok.status).toBe(200);
    }
    // 6th is rate-limited.
    const blocked = await POST(
      postReq({ answers: { q1: "Nick" } }, "9.9.9.9"),
      ctx("abc1234"),
    );
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toEqual({ error: "rate_limited" });
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "survey.response_rejected",
      "public",
      "public",
      expect.objectContaining({ reason: "rate_limited" }),
    );
  });

  test("rate limit is keyed per ip-hash (different ip not blocked)", async () => {
    mockGetPublished.mockResolvedValue(PUBLISHED_SURVEY);
    mockSubmitResponse.mockResolvedValue({ id: "resp-y" });
    for (let i = 0; i < 5; i += 1) {
      await POST(postReq({ answers: { q1: "x" } }, "5.5.5.5"), ctx("abc1234"));
    }
    const other = await POST(
      postReq({ answers: { q1: "x" } }, "6.6.6.6"),
      ctx("abc1234"),
    );
    expect(other.status).toBe(200);
  });
});
