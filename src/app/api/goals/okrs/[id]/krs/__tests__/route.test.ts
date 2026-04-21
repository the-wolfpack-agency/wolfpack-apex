/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * POST /api/goals/okrs/[id]/krs
 *
 * Locks:
 *   - 401 without auth
 *   - any authenticated role (not just admin) can add a KR
 *   - 400 on invalid metric / target
 *   - 404 when addKRToOKR returns null (archived or missing OKR)
 *   - 201 returns { kr } on success
 *   - passes normalized body + user id into addKRToOKR
 */

const mockAdd = jest.fn();
const mockGetUser = jest.fn();

jest.mock("@/lib/goals", () => ({
  addKRToOKR: (...a: any[]) => mockAdd(...a),
}));
jest.mock("@/lib/auth", () => ({
  getUserFromRequest: (...a: any[]) => mockGetUser(...a),
}));

import { NextRequest } from "next/server";
import { POST } from "../route";

function req(body: unknown) {
  return new NextRequest("https://x.test/api/goals/okrs/okr-1/krs", {
    method: "POST",
    headers: { authorization: "Bearer x", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  mockAdd.mockReset();
  mockGetUser.mockReset();
});

describe("POST /api/goals/okrs/[id]/krs", () => {
  test("401 without auth", async () => {
    mockGetUser.mockReturnValue(null);
    const res = await POST(req({ metric: "x", target: 1 }), ctx("okr-1"));
    expect(res.status).toBe(401);
    expect(mockAdd).not.toHaveBeenCalled();
  });

  test("400 when metric missing", async () => {
    mockGetUser.mockReturnValue({ id: "u1", role: "dev", name: "", email: "", created_at: "" });
    const res = await POST(req({ target: 1 }), ctx("okr-1"));
    expect(res.status).toBe(400);
  });

  test("400 when target not a finite number", async () => {
    mockGetUser.mockReturnValue({ id: "u1", role: "dev", name: "", email: "", created_at: "" });
    const res = await POST(req({ metric: "signups", target: "abc" }), ctx("okr-1"));
    expect(res.status).toBe(400);
  });

  test("accepts target_value alias alongside target", async () => {
    mockGetUser.mockReturnValue({ id: "u1", role: "dev", name: "", email: "", created_at: "" });
    mockAdd.mockResolvedValue({ id: "kr-1", okr_id: "okr-1", metric: "m" });
    await POST(req({ metric: "m", target_value: 7 }), ctx("okr-1"));
    expect(mockAdd).toHaveBeenCalledWith(
      "okr-1",
      expect.objectContaining({ target: 7 }),
      "u1",
    );
  });

  test("non-admin roles (dev, sales) can add a KR — not role-gated", async () => {
    mockGetUser.mockReturnValue({ id: "u-dev", role: "dev", name: "", email: "", created_at: "" });
    mockAdd.mockResolvedValue({ id: "kr-1", okr_id: "okr-1", metric: "m" });
    const res = await POST(req({ metric: "m", target: 1 }), ctx("okr-1"));
    expect(res.status).toBe(201);
  });

  test("404 when addKRToOKR returns null (archived or missing)", async () => {
    mockGetUser.mockReturnValue({ id: "u1", role: "dev", name: "", email: "", created_at: "" });
    mockAdd.mockResolvedValue(null);
    const res = await POST(req({ metric: "m", target: 1 }), ctx("ghost"));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("okr_not_found_or_archived");
  });

  test("201 returns { kr } + trims metric + normalizes unit/cadence defaults", async () => {
    mockGetUser.mockReturnValue({ id: "u1", role: "dev", name: "", email: "", created_at: "" });
    mockAdd.mockResolvedValue({
      id: "kr-new",
      okr_id: "okr-1",
      metric: "signups",
      target_value: 250,
    });
    const res = await POST(
      req({ metric: "  signups  ", target: 250, unit: "users", cadence: "weekly" }),
      ctx("okr-1"),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.kr.id).toBe("kr-new");
    expect(mockAdd).toHaveBeenCalledWith(
      "okr-1",
      { metric: "signups", target: 250, unit: "users", cadence: "weekly" },
      "u1",
    );
  });
});
