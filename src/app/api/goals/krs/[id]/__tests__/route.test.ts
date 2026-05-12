 
const mockUpdateCurrent = jest.fn();
const mockUpdateKR = jest.fn();
const mockDeleteKR = jest.fn();
const mockGetUser = jest.fn();

jest.mock("@/lib/goals", () => ({
  updateKRCurrent: (...a: any[]) => mockUpdateCurrent(...a),
  updateKR: (...a: any[]) => mockUpdateKR(...a),
  deleteKR: (...a: any[]) => mockDeleteKR(...a),
}));
jest.mock("@/lib/auth", () => ({
  getUserFromRequest: (...a: any[]) => mockGetUser(...a),
}));

import { NextRequest } from "next/server";
import { PATCH, DELETE } from "../route";

function req(method: "PATCH" | "DELETE", body?: unknown) {
  return new NextRequest("https://x.test/api/goals/krs/k1", {
    method,
    headers: { authorization: "Bearer x", "Content-Type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  mockUpdateCurrent.mockReset();
  mockUpdateKR.mockReset();
  mockDeleteKR.mockReset();
  mockGetUser.mockReset();
});

describe("PATCH /api/goals/krs/[id] — progress path (all roles)", () => {
  test("non-admin can still update current_value", async () => {
    mockGetUser.mockReturnValue({ id: "u1", role: "dev", name: "", email: "" });
    mockUpdateCurrent.mockResolvedValue({ id: "k1", current_value: 50 });
    const res = await PATCH(req("PATCH", { current_value: 50 }), ctx("k1"));
    expect(res.status).toBe(200);
    expect(mockUpdateCurrent).toHaveBeenCalled();
    expect(mockUpdateKR).not.toHaveBeenCalled();
  });
  test("400 when current_value is not finite", async () => {
    mockGetUser.mockReturnValue({ id: "u1", role: "ceo", name: "", email: "" });
    const res = await PATCH(req("PATCH", { current_value: "x" }), ctx("k1"));
    expect(res.status).toBe(400);
  });
});

describe("PATCH /api/goals/krs/[id] — definition edit (admin only)", () => {
  test("403 when non-admin attempts metric/target edit", async () => {
    mockGetUser.mockReturnValue({ id: "u1", role: "dev", name: "", email: "" });
    const res = await PATCH(req("PATCH", { metric: "new", target: 100 }), ctx("k1"));
    expect(res.status).toBe(403);
    expect(mockUpdateKR).not.toHaveBeenCalled();
  });
  test("admin can patch metric/target/unit/cadence", async () => {
    mockGetUser.mockReturnValue({ id: "u1", role: "cto", name: "", email: "" });
    mockUpdateKR.mockResolvedValue({ id: "k1", metric: "activations", target_value: 500 });
    const res = await PATCH(
      req("PATCH", { metric: "activations", target: 500, unit: "users", cadence: "monthly" }),
      ctx("k1"),
    );
    expect(res.status).toBe(200);
    expect(mockUpdateKR).toHaveBeenCalledWith(
      "k1",
      { metric: "activations", target: 500, unit: "users", cadence: "monthly" },
      "u1",
    );
  });
  test("accepts target_value alias", async () => {
    mockGetUser.mockReturnValue({ id: "u1", role: "ceo", name: "", email: "" });
    mockUpdateKR.mockResolvedValue({ id: "k1" });
    await PATCH(req("PATCH", { target_value: 7 }), ctx("k1"));
    expect(mockUpdateKR).toHaveBeenCalledWith(
      "k1",
      expect.objectContaining({ target: 7 }),
      "u1",
    );
  });
  test("404 when updateKR returns null", async () => {
    mockGetUser.mockReturnValue({ id: "u1", role: "ceo", name: "", email: "" });
    mockUpdateKR.mockResolvedValue(null);
    const res = await PATCH(req("PATCH", { metric: "x" }), ctx("gone"));
    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/goals/krs/[id]", () => {
  test("401 unauth", async () => {
    mockGetUser.mockReturnValue(null);
    expect((await DELETE(req("DELETE"), ctx("k1"))).status).toBe(401);
  });
  test("403 non-admin", async () => {
    mockGetUser.mockReturnValue({ id: "u1", role: "sales", name: "", email: "" });
    expect((await DELETE(req("DELETE"), ctx("k1"))).status).toBe(403);
  });
  test("404 when missing", async () => {
    mockGetUser.mockReturnValue({ id: "u1", role: "ceo", name: "", email: "" });
    mockDeleteKR.mockResolvedValue(null);
    expect((await DELETE(req("DELETE"), ctx("ghost"))).status).toBe(404);
  });
  test("200 on success", async () => {
    mockGetUser.mockReturnValue({ id: "u1", role: "cto", name: "", email: "" });
    mockDeleteKR.mockResolvedValue({ id: "k1" });
    const res = await DELETE(req("DELETE"), ctx("k1"));
    expect(res.status).toBe(200);
    expect(mockDeleteKR).toHaveBeenCalledWith("k1", "u1");
  });
});
