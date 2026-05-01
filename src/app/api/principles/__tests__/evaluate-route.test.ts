/* eslint-disable @typescript-eslint/no-explicit-any */
const mockGetById = jest.fn();
const mockEvaluate = jest.fn();
const mockTrack = jest.fn();
let authUser: { id: string; role: string } | null = { id: "u-cto", role: "cto" };

jest.mock("@/lib/principles/store", () => ({
  getActivePrincipleById: (...a: any[]) => mockGetById(...a),
}));
jest.mock("@/lib/principles/evaluate-runner", () => ({
  evaluatePrinciples: (...a: any[]) => mockEvaluate(...a),
}));
jest.mock("@/lib/auth", () => ({
  getUserFromRequest: () => authUser,
}));
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: any[]) => mockTrack(...a),
}));

import { NextRequest } from "next/server";
import { POST as postEvaluate } from "../[id]/evaluate/route";

beforeEach(() => {
  mockGetById.mockReset();
  mockEvaluate.mockReset();
  mockTrack.mockReset();
  authUser = { id: "u-cto", role: "cto" };
});

const post = (id: string) =>
  new NextRequest(`https://wp.test/api/principles/${id}/evaluate`, {
    method: "POST",
    headers: { authorization: "Bearer x" },
  });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

describe("POST /api/principles/[id]/evaluate", () => {
  test("401 unauthenticated", async () => {
    authUser = null;
    const res = await postEvaluate(post("p1"), ctx("p1"));
    expect(res.status).toBe(401);
    expect(mockEvaluate).not.toHaveBeenCalled();
  });

  test("403 for non-leadership", async () => {
    authUser = { id: "u-sales", role: "sales" };
    const res = await postEvaluate(post("p1"), ctx("p1"));
    expect(res.status).toBe(403);
  });

  test("404 when principle missing or retired", async () => {
    mockGetById.mockResolvedValueOnce(null);
    const res = await postEvaluate(post("p1"), ctx("p1"));
    expect(res.status).toBe(404);
    expect(mockEvaluate).not.toHaveBeenCalled();
  });

  test("runs runner with forceBootstrap and returns counts", async () => {
    mockGetById.mockResolvedValueOnce({
      id: "p1",
      slug: "ship-fast",
      title: "Ship fast",
    });
    mockEvaluate.mockResolvedValueOnce({
      bindingCount: 2,
      userCount: 4,
      observationCount: 7,
      failureCount: 0,
      perValidator: { "mail.after_hours": 4, "calendar.focus_block_ratio": 3 },
    });
    const res = await postEvaluate(post("p1"), ctx("p1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.observations).toBe(7);
    expect(body.users).toBe(4);
    expect(body.bindings).toBe(2);
    expect(mockEvaluate).toHaveBeenCalledWith(
      [expect.objectContaining({ id: "p1" })],
      expect.objectContaining({ forceBootstrap: true }),
    );
    expect(mockTrack).toHaveBeenCalledWith(
      "principle.observations_recorded",
      "u-cto",
      "cto",
      expect.objectContaining({ trigger: "manual", principle_id: "p1" }),
    );
  });

  test("surfaces skippedReason when no bindings", async () => {
    mockGetById.mockResolvedValueOnce({ id: "p1", slug: "x", title: "X" });
    mockEvaluate.mockResolvedValueOnce({
      bindingCount: 0,
      userCount: 0,
      observationCount: 0,
      failureCount: 0,
      perValidator: {},
      skippedReason: "no_bindings",
    });
    const res = await postEvaluate(post("p1"), ctx("p1"));
    const body = await res.json();
    expect(body.skippedReason).toBe("no_bindings");
  });
});
