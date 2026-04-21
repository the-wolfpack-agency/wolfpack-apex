/* eslint-disable @typescript-eslint/no-explicit-any */
const mockArchive = jest.fn();
const mockGetUser = jest.fn();
const mockTrackEvent = jest.fn();

jest.mock("@/lib/goals", () => ({
  archiveOKR: (...a: any[]) => mockArchive(...a),
}));
jest.mock("@/lib/auth", () => ({
  getUserFromRequest: (...a: any[]) => mockGetUser(...a),
}));
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: any[]) => mockTrackEvent(...a),
}));

import { NextRequest } from "next/server";
import { DELETE } from "../route";

function req() {
  return new NextRequest("https://x.test/api/goals/okrs/o1", {
    method: "DELETE",
    headers: { authorization: "Bearer x" },
  });
}

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  mockArchive.mockReset();
  mockGetUser.mockReset();
  mockTrackEvent.mockReset();
});

describe("DELETE /api/goals/okrs/[id]", () => {
  test("401 without auth", async () => {
    mockGetUser.mockReturnValue(null);
    const res = await DELETE(req(), ctx("o1"));
    expect(res.status).toBe(401);
    expect(mockArchive).not.toHaveBeenCalled();
  });

  test("403 for non-admin roles", async () => {
    mockGetUser.mockReturnValue({ id: "u1", role: "dev", name: "", email: "", created_at: "" });
    const res = await DELETE(req(), ctx("o1"));
    expect(res.status).toBe(403);
    expect(mockArchive).not.toHaveBeenCalled();
  });

  test("404 when archiveOKR returns null", async () => {
    mockGetUser.mockReturnValue({ id: "u1", role: "ceo", name: "", email: "", created_at: "" });
    mockArchive.mockResolvedValue(null);
    const res = await DELETE(req(), ctx("ghost"));
    expect(res.status).toBe(404);
    expect(mockTrackEvent).not.toHaveBeenCalled();
  });

  test("200 on success + fires goal.okr_archived", async () => {
    mockGetUser.mockReturnValue({ id: "u1", role: "cto", name: "", email: "", created_at: "" });
    mockArchive.mockResolvedValue({ id: "o1", status: "archived" });
    const res = await DELETE(req(), ctx("o1"));
    expect(res.status).toBe(200);
    expect(mockTrackEvent).toHaveBeenCalledTimes(1);
    const [evt, , , meta] = mockTrackEvent.mock.calls[0];
    expect(evt).toBe("goal.okr_archived");
    expect(meta.okr_id).toBe("o1");
  });
});
