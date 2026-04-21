/* eslint-disable @typescript-eslint/no-explicit-any */
const mockDelete = jest.fn();
const mockUpdate = jest.fn();
const mockGetUser = jest.fn();
const mockTrackEvent = jest.fn();

jest.mock("@/lib/goals-contributions", () => ({
  deleteContribution: (...a: any[]) => mockDelete(...a),
  updateContributionDescription: (...a: any[]) => mockUpdate(...a),
}));
jest.mock("@/lib/auth", () => ({
  getUserFromRequest: (...a: any[]) => mockGetUser(...a),
}));
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: any[]) => mockTrackEvent(...a),
}));

import { NextRequest } from "next/server";
import { DELETE, PATCH } from "../route";

function req(method: "DELETE" | "PATCH", body?: unknown) {
  return new NextRequest("https://x.test/api/goals/contributions/c1", {
    method,
    headers: { authorization: "Bearer x", "Content-Type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  mockDelete.mockReset();
  mockUpdate.mockReset();
  mockGetUser.mockReset();
  mockTrackEvent.mockReset();
});

describe("DELETE /api/goals/contributions/[id]", () => {
  test("401 without auth", async () => {
    mockGetUser.mockReturnValue(null);
    expect((await DELETE(req("DELETE"), ctx("c1"))).status).toBe(401);
  });
  test("403 for non-admin", async () => {
    mockGetUser.mockReturnValue({ id: "u1", role: "dev", name: "", email: "" });
    expect((await DELETE(req("DELETE"), ctx("c1"))).status).toBe(403);
  });
  test("404 when missing", async () => {
    mockGetUser.mockReturnValue({ id: "u1", role: "cto", name: "", email: "" });
    mockDelete.mockResolvedValue(null);
    expect((await DELETE(req("DELETE"), ctx("ghost"))).status).toBe(404);
  });
  test("200 + analytics on success", async () => {
    mockGetUser.mockReturnValue({ id: "u1", role: "ceo", name: "", email: "" });
    mockDelete.mockResolvedValue({ id: "c1" });
    const res = await DELETE(req("DELETE"), ctx("c1"));
    expect(res.status).toBe(200);
    expect(mockTrackEvent.mock.calls[0][0]).toBe("goal.contribution_deleted");
  });
});

describe("PATCH /api/goals/contributions/[id]", () => {
  test("400 when description missing or blank", async () => {
    mockGetUser.mockReturnValue({ id: "u1", role: "ceo", name: "", email: "" });
    expect((await PATCH(req("PATCH", { description: "" }), ctx("c1"))).status).toBe(400);
  });
  test("200 with updated description, fires analytics", async () => {
    mockGetUser.mockReturnValue({ id: "u1", role: "ceo", name: "", email: "" });
    mockUpdate.mockResolvedValue({ id: "c1", description: "new text" });
    const res = await PATCH(req("PATCH", { description: " new text " }), ctx("c1"));
    expect(res.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalledWith("c1", " new text ");
    expect(mockTrackEvent.mock.calls[0][0]).toBe("goal.contribution_edited");
  });
});
