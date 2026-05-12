 
const mockGetUser = jest.fn();
const mockCanRead = jest.fn();
const mockListActive = jest.fn();
const mockEvaluate = jest.fn();
const mockTrack = jest.fn();

jest.mock("@/lib/auth", () => ({
  getUserFromRequest: (...a: any[]) => mockGetUser(...a),
}));
jest.mock("@/lib/principles/authz", () => ({
  canReadTeamEvidence: (...a: any[]) => mockCanRead(...a),
}));
jest.mock("@/lib/principles/store", () => ({
  listActivePrinciples: (...a: any[]) => mockListActive(...a),
}));
jest.mock("@/lib/principles/evaluate-runner", () => ({
  evaluatePrinciples: (...a: any[]) => mockEvaluate(...a),
}));
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: any[]) => mockTrack(...a),
}));

import { NextRequest } from "next/server";
import { POST } from "../route";

beforeEach(() => {
  mockGetUser.mockReset();
  mockCanRead.mockReset();
  mockListActive.mockReset();
  mockEvaluate.mockReset();
  mockTrack.mockReset();
});

const req = (auth?: string) =>
  new NextRequest("https://wp.test/api/principles/evaluate-all", {
    method: "POST",
    headers: auth ? { authorization: auth } : {},
  });

const principle = (id: string, slug: string) => ({
  id,
  slug,
  title: slug,
  domains: [],
  owner: null,
  bodyMd: "",
  scoreboardWeight: 1,
  sourceUrl: null,
  sourceDocHash: null,
  effectiveAt: null,
  retiredAt: null,
  createdAt: "2026-05-01",
  updatedAt: "2026-05-01",
});

describe("POST /api/principles/evaluate-all", () => {
  test("401 without auth", async () => {
    mockGetUser.mockReturnValueOnce(null);
    const res = await POST(req());
    expect(res.status).toBe(401);
  });

  test("403 when caller is not leadership", async () => {
    mockGetUser.mockReturnValueOnce({ id: "u1", role: "member" });
    mockCanRead.mockReturnValueOnce(false);
    const res = await POST(req("Bearer x"));
    expect(res.status).toBe(403);
  });

  test("returns ok:true with zeros when there are no active principles", async () => {
    mockGetUser.mockReturnValueOnce({ id: "u1", role: "ceo" });
    mockCanRead.mockReturnValueOnce(true);
    mockListActive.mockResolvedValueOnce([]);
    const res = await POST(req("Bearer x"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      ok: true,
      principles: 0,
      observations: 0,
      perPrinciple: [],
    });
  });

  test("evaluates each active principle sequentially and aggregates totals", async () => {
    mockGetUser.mockReturnValueOnce({ id: "u1", role: "ceo" });
    mockCanRead.mockReturnValueOnce(true);
    mockListActive.mockResolvedValueOnce([
      principle("p1", "ship-fast"),
      principle("p2", "respect-off-hours"),
    ]);
    mockEvaluate
      .mockResolvedValueOnce({
        bindingCount: 2,
        userCount: 2,
        observationCount: 5,
        failureCount: 0,
        perValidator: {},
      })
      .mockResolvedValueOnce({
        bindingCount: 1,
        userCount: 2,
        observationCount: 3,
        failureCount: 0,
        perValidator: {},
      });
    const res = await POST(req("Bearer x"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.principles).toBe(2);
    expect(body.observations).toBe(8);
    expect(body.perPrinciple).toHaveLength(2);
    expect(body.perPrinciple[0]).toMatchObject({ slug: "ship-fast", observations: 5 });
    expect(mockEvaluate).toHaveBeenCalledTimes(2);
    expect(mockEvaluate.mock.calls[0][1]).toEqual({ forceBootstrap: true });
    expect(mockTrack).toHaveBeenCalledWith(
      "principle.observations_recorded",
      "u1",
      "ceo",
      expect.objectContaining({
        trigger: "manual_all",
        principle_count: 2,
        observation_count: 8,
      }),
    );
  });

  test("one failing principle isolates — others still evaluate", async () => {
    mockGetUser.mockReturnValueOnce({ id: "u1", role: "ceo" });
    mockCanRead.mockReturnValueOnce(true);
    mockListActive.mockResolvedValueOnce([
      principle("p1", "broken"),
      principle("p2", "good"),
    ]);
    mockEvaluate
      .mockRejectedValueOnce(new Error("graph 503"))
      .mockResolvedValueOnce({
        bindingCount: 1,
        userCount: 1,
        observationCount: 2,
        failureCount: 0,
        perValidator: {},
      });
    const res = await POST(req("Bearer x"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.observations).toBe(2);
    expect(body.perPrinciple[0]).toMatchObject({
      slug: "broken",
      failures: 1,
    });
    expect(mockTrack).toHaveBeenCalledWith(
      "principle.evaluation_failed",
      "u1",
      "ceo",
      expect.objectContaining({ trigger: "manual_all", principle_id: "p1" }),
    );
  });
});
