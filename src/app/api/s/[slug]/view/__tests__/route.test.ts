/**
 * Contract tests for the PUBLIC survey VIEW beacon (/api/s/[slug]/view).
 *
 * The beacon captures the TOP of the completion funnel. Its contract is
 * deliberately forgiving — a view beacon must never error the page it's
 * measuring:
 *   - 200 + recordSurveyView + survey.viewed for a published survey.
 *   - 404 for a missing / unpublished survey (the only non-200).
 *   - 200 EVEN WHEN recordSurveyView throws (swallowed, page unaffected).
 *
 * The store + analytics are mocked so no Postgres is touched.
 */

const mockGetPublished = jest.fn();
const mockRecordView = jest.fn();
const mockTrackEvent = jest.fn();

jest.mock("@/lib/surveys/store", () => ({
  getPublishedSurveyBySlug: (...a: unknown[]) => mockGetPublished(...a),
  recordSurveyView: (...a: unknown[]) => mockRecordView(...a),
}));
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: unknown[]) => mockTrackEvent(...a),
}));

import { NextRequest } from "next/server";
import { POST, _resetRateLimit } from "../route";

const PUBLISHED_SURVEY = {
  id: "survey-1",
  slug: "abc1234",
  title: "Test survey",
  description: "How are we doing?",
  schema: { questions: [] },
  status: "published",
};

function ctx(slug: string) {
  return { params: Promise.resolve({ slug }) };
}

function viewReq(opts?: {
  ip?: string;
  ua?: string;
  country?: string;
  referer?: string;
}): NextRequest {
  const headers: Record<string, string> = {
    "x-forwarded-for": opts?.ip ?? "1.2.3.4",
    "user-agent":
      opts?.ua ?? "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Mobile/15E148",
  };
  if (opts?.country) headers["x-vercel-ip-country"] = opts.country;
  if (opts?.referer) headers["referer"] = opts.referer;
  return new NextRequest("https://x.test/api/s/abc1234/view", {
    method: "POST",
    headers,
  });
}

beforeEach(() => {
  mockGetPublished.mockReset();
  mockRecordView.mockReset();
  mockTrackEvent.mockReset();
  _resetRateLimit();
});

describe("POST /api/s/[slug]/view", () => {
  test("200 + records view + emits survey.viewed for a published survey", async () => {
    mockGetPublished.mockResolvedValue(PUBLISHED_SURVEY);
    mockRecordView.mockResolvedValue(undefined);

    const res = await POST(
      viewReq({ country: "US", referer: "https://t.co/x" }),
      ctx("abc1234"),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    expect(mockRecordView).toHaveBeenCalledTimes(1);
    expect(mockRecordView).toHaveBeenCalledWith(
      expect.objectContaining({
        surveyId: "survey-1",
        respondentFingerprint: expect.any(String),
        device: "mobile",
        country: "US",
        referrer: "https://t.co/x",
      }),
    );
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "survey.viewed",
      "public",
      "public",
      expect.objectContaining({
        survey_id: "survey-1",
        slug: "abc1234",
        device: "mobile",
        country: "US",
      }),
    );
  });

  test("404 when the survey is missing / unpublished", async () => {
    mockGetPublished.mockResolvedValue(null);
    const res = await POST(viewReq(), ctx("nope"));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
    expect(mockRecordView).not.toHaveBeenCalled();
    expect(mockTrackEvent).not.toHaveBeenCalled();
  });

  test("beacon still returns 200 even when recordSurveyView throws", async () => {
    mockGetPublished.mockResolvedValue(PUBLISHED_SURVEY);
    mockRecordView.mockRejectedValue(new Error("db down"));

    const res = await POST(viewReq(), ctx("abc1234"));

    // The page must never see an error from a fire-and-forget beacon.
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mockRecordView).toHaveBeenCalledTimes(1);
  });

  test("country derives null when the edge header is absent", async () => {
    mockGetPublished.mockResolvedValue(PUBLISHED_SURVEY);
    mockRecordView.mockResolvedValue(undefined);

    await POST(viewReq(), ctx("abc1234"));

    expect(mockRecordView).toHaveBeenCalledWith(
      expect.objectContaining({ country: null }),
    );
  });

  test("over the generous per-ip budget the beacon still 200s (skips the write)", async () => {
    mockGetPublished.mockResolvedValue(PUBLISHED_SURVEY);
    mockRecordView.mockResolvedValue(undefined);

    // Budget is 60/window. The 61st from the same ip skips the write.
    for (let i = 0; i < 60; i += 1) {
      const ok = await POST(viewReq({ ip: "9.9.9.9" }), ctx("abc1234"));
      expect(ok.status).toBe(200);
    }
    expect(mockRecordView).toHaveBeenCalledTimes(60);

    const over = await POST(viewReq({ ip: "9.9.9.9" }), ctx("abc1234"));
    expect(over.status).toBe(200);
    expect(await over.json()).toEqual({ ok: true });
    // Still 60 — the over-budget beacon did not write.
    expect(mockRecordView).toHaveBeenCalledTimes(60);
  });
});
