/* eslint-disable @typescript-eslint/no-explicit-any */
const mockListPrinciples = jest.fn();
const mockListAll = jest.fn();
const mockResolveNames = jest.fn();
const mockUpsert = jest.fn();
const mockTrack = jest.fn();

jest.mock("@/lib/principles/store", () => ({
  listActivePrinciples: (...a: any[]) => mockListPrinciples(...a),
  listAllObservations: (...a: any[]) => mockListAll(...a),
}));
jest.mock("@/lib/principles/user-names", () => ({
  resolveUserNames: (...a: any[]) => mockResolveNames(...a),
}));
jest.mock("@/lib/principles/weekly-report", () => {
  const actual = jest.requireActual("@/lib/principles/weekly-report");
  return {
    ...actual,
    upsertWeeklyReport: (...a: any[]) => mockUpsert(...a),
  };
});
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: any[]) => mockTrack(...a),
}));

import { NextRequest } from "next/server";
import { GET } from "../route";

const ORIG_ENV = { ...process.env };

beforeEach(() => {
  mockListPrinciples.mockReset();
  mockListAll.mockReset();
  mockResolveNames.mockReset();
  mockUpsert.mockReset();
  mockTrack.mockReset();
  process.env.CRON_SECRET = "secret-x";
});
afterAll(() => {
  process.env = ORIG_ENV;
});

const reqWith = (auth?: string) =>
  new NextRequest("https://wp.test/api/cron/principles-weekly-report", {
    method: "GET",
    headers: auth ? { authorization: auth } : {},
  });

describe("GET /api/cron/principles-weekly-report", () => {
  test("401 without secret", async () => {
    const res = await GET(reqWith());
    expect(res.status).toBe(401);
  });
  test("happy path: builds, upserts, emits weekly_report_published", async () => {
    mockListPrinciples.mockResolvedValueOnce([
      {
        id: "p1",
        slug: "x",
        title: "X",
        domains: [],
        owner: null,
        bodyMd: "",
        scoreboardWeight: 1,
        sourceUrl: null,
        sourceDocHash: null,
        effectiveAt: null,
        retiredAt: null,
        createdAt: "x",
        updatedAt: "x",
      },
    ]);
    mockListAll.mockResolvedValueOnce([
      {
        id: "o1",
        principleId: "p1",
        signalId: null,
        validatorId: "v",
        surface: "mail",
        surfaceSubtype: "x",
        subjectUserId: "u1",
        observedAt: "2026-05-01",
        score: -0.5,
        evidenceJsonb: {},
      },
    ]);
    mockResolveNames.mockResolvedValueOnce(new Map());
    mockUpsert.mockResolvedValueOnce({
      id: "r1",
      weekStart: "2026-04-28",
      weekEnd: "2026-05-05",
      markdownBody: "md",
      observationCount: 1,
      principleCount: 1,
      generatedAt: "x",
    });
    const res = await GET(reqWith("Bearer secret-x"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.observationCount).toBe(1);
    expect(mockTrack).toHaveBeenCalledWith(
      "principle.weekly_report_published",
      "system",
      "system",
      expect.objectContaining({
        observation_count: 1,
        principle_count: 1,
      }),
    );
  });
  test("upsert error → 500 + weekly_report_failed event", async () => {
    mockListPrinciples.mockResolvedValueOnce([]);
    mockListAll.mockResolvedValueOnce([]);
    mockResolveNames.mockResolvedValueOnce(new Map());
    mockUpsert.mockRejectedValueOnce(new Error("db down"));
    const res = await GET(reqWith("Bearer secret-x"));
    expect(res.status).toBe(500);
    expect(mockTrack).toHaveBeenCalledWith(
      "principle.weekly_report_failed",
      "system",
      "system",
      expect.objectContaining({ error: "db down" }),
    );
  });
});
