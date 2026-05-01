/* eslint-disable @typescript-eslint/no-explicit-any */
const mockListPrinciples = jest.fn();
const mockListSignals = jest.fn();
const mockInsertObs = jest.fn();
const mockListUsers = jest.fn();
const mockTrack = jest.fn();
const mockEvaluate = jest.fn();
const mockFindValidator = jest.fn();

jest.mock("@/lib/principles/store", () => ({
  listActivePrinciples: (...a: any[]) => mockListPrinciples(...a),
  listSignalsForPrinciple: (...a: any[]) => mockListSignals(...a),
  insertObservations: (...a: any[]) => mockInsertObs(...a),
}));
jest.mock("@/lib/principles/users-iterator", () => ({
  listConnectedM365Users: (...a: any[]) => mockListUsers(...a),
}));
jest.mock("@/lib/principles/validators", () => {
  const actual = jest.requireActual("@/lib/principles/validators");
  return {
    ...actual,
    findValidatorForDescription: (...a: any[]) => mockFindValidator(...a),
  };
});
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: any[]) => mockTrack(...a),
}));
jest.mock("@/lib/principles/built-in-validators", () => ({}));

import { NextRequest } from "next/server";
import { GET } from "../route";

const ORIG_ENV = { ...process.env };

beforeEach(() => {
  mockListPrinciples.mockReset();
  mockListSignals.mockReset();
  mockInsertObs.mockReset();
  mockListUsers.mockReset();
  mockTrack.mockReset();
  mockEvaluate.mockReset();
  mockFindValidator.mockReset();
  process.env.CRON_SECRET = "secret-x";
});

afterAll(() => {
  process.env = ORIG_ENV;
});

function reqWith(auth?: string, qs = ""): NextRequest {
  return new NextRequest(`https://wp.test/api/cron/principles-evaluate${qs}`, {
    method: "GET",
    headers: auth ? { authorization: auth } : {},
  });
}

describe("GET /api/cron/principles-evaluate", () => {
  test("401 without secret", async () => {
    const res = await GET(reqWith());
    expect(res.status).toBe(401);
  });
  test("no_bindings when no validator binds to any signal", async () => {
    mockListPrinciples.mockResolvedValueOnce([
      { id: "p1", slug: "x", title: "X" },
    ]);
    mockListSignals.mockResolvedValueOnce([
      { id: "s1", description: "vague" },
    ]);
    mockFindValidator.mockReturnValueOnce(null);
    const res = await GET(reqWith("Bearer secret-x"));
    const body = await res.json();
    expect(body.reason).toBe("no_bindings");
    expect(mockTrack).toHaveBeenCalledWith(
      "principle.evaluation_skipped",
      "system",
      "system",
      expect.objectContaining({ reason: "no_bindings" }),
    );
  });
  test("no_connected_users when iterator returns []", async () => {
    mockListPrinciples.mockResolvedValueOnce([
      { id: "p1", slug: "x", title: "X" },
    ]);
    mockListSignals.mockResolvedValueOnce([
      { id: "s1", description: "after hours" },
    ]);
    mockFindValidator.mockReturnValueOnce({
      id: "mail.after_hours_send",
      surface: "mail",
      describe: "x",
      matches: () => true,
      evaluate: mockEvaluate,
    });
    mockListUsers.mockResolvedValueOnce([]);
    const res = await GET(reqWith("Bearer secret-x"));
    const body = await res.json();
    expect(body.reason).toBe("no_connected_users");
  });
  test("happy path: fan out × insert × emit observations_recorded", async () => {
    mockListPrinciples.mockResolvedValueOnce([
      { id: "p1", slug: "respect-off-hours", title: "Respect off-hours" },
    ]);
    mockListSignals.mockResolvedValueOnce([
      { id: "s1", description: "after-hours sends" },
    ]);
    mockFindValidator.mockReturnValueOnce({
      id: "mail.after_hours_send",
      surface: "mail",
      describe: "x",
      matches: () => true,
      evaluate: async (ctx: { subjectUserId: string }) => [
        {
          surface: "mail",
          surfaceSubtype: "outlook_send_after_hours",
          subjectUserId: ctx.subjectUserId,
          observedAt: "2026-05-01T03:30:00Z",
          score: -0.6,
          evidence: { kind: "x" },
        },
      ],
    });
    mockListUsers.mockResolvedValueOnce([
      { userId: "u1" },
      { userId: "u2" },
    ]);
    mockInsertObs.mockResolvedValueOnce(2);
    const res = await GET(reqWith("Bearer secret-x"));
    const body = await res.json();
    expect(body.observations).toBe(2);
    expect(body.users).toBe(2);
    expect(mockInsertObs.mock.calls[0][0].rows).toHaveLength(2);
    expect(mockTrack).toHaveBeenCalledWith(
      "principle.observations_recorded",
      "system",
      "system",
      expect.objectContaining({
        observation_count: 2,
        user_count: 2,
        binding_count: 1,
      }),
    );
  });
  test("one user's evaluator throwing doesn't block the rest + emits evaluation_failed", async () => {
    mockListPrinciples.mockResolvedValueOnce([{ id: "p1", slug: "x", title: "X" }]);
    mockListSignals.mockResolvedValueOnce([{ id: "s1", description: "x" }]);
    let call = 0;
    mockFindValidator.mockReturnValueOnce({
      id: "v1",
      surface: "mail",
      describe: "x",
      matches: () => true,
      evaluate: async (ctx: { subjectUserId: string }) => {
        call++;
        if (call === 1) throw new Error("token revoked");
        return [
          {
            surface: "mail",
            subjectUserId: ctx.subjectUserId,
            observedAt: "2026-05-01T00:00:00Z",
            score: -0.5,
            evidence: { kind: "x" },
          },
        ];
      },
    });
    mockListUsers.mockResolvedValueOnce([
      { userId: "u-broken" },
      { userId: "u-good" },
    ]);
    mockInsertObs.mockResolvedValueOnce(1);
    const res = await GET(reqWith("Bearer secret-x"));
    const body = await res.json();
    expect(body.observations).toBe(1);
    expect(body.failures).toBe(1);
    expect(mockTrack).toHaveBeenCalledWith(
      "principle.evaluation_failed",
      "u-broken",
      "system",
      expect.objectContaining({ validator_id: "v1" }),
    );
  });
});
