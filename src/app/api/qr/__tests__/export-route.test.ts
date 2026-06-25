const mockTrackEvent = jest.fn();
let authUser: { id: string; role: string } | null = { id: "u1", role: "ceo" };

jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: unknown[]) => mockTrackEvent(...a) }));
jest.mock("@/lib/auth", () => ({ getUserFromRequest: () => authUser }));

import { NextRequest } from "next/server";
import { POST } from "../[id]/export/route";

function req(body: unknown): NextRequest {
  return new NextRequest("https://wp.test/api/qr/c1/export", {
    method: "POST",
    headers: { authorization: "Bearer t", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
const ctx = { params: Promise.resolve({ id: "c1" }) };

beforeEach(() => { mockTrackEvent.mockReset(); authUser = { id: "u1", role: "ceo" }; });

test("401 when unauthenticated", async () => {
  authUser = null;
  const res = await POST(req({ format: "eps" }), ctx);
  expect(res.status).toBe(401);
  expect(mockTrackEvent).not.toHaveBeenCalled();
});

test("200 records assistant.qr_code_exported with the code id + format", async () => {
  const res = await POST(req({ format: "eps" }), ctx);
  expect(res.status).toBe(200);
  expect(mockTrackEvent).toHaveBeenCalledWith("assistant.qr_code_exported", "u1", "ceo", { code_id: "c1", format: "eps" });
});

test("an unknown/garbage format is normalized to 'unknown' (closed set)", async () => {
  await POST(req({ format: "exe" }), ctx);
  expect(mockTrackEvent).toHaveBeenCalledWith("assistant.qr_code_exported", "u1", "ceo", { code_id: "c1", format: "unknown" });
});

test("tolerates a missing/invalid body", async () => {
  const bad = new NextRequest("https://wp.test/api/qr/c1/export", { method: "POST", headers: { authorization: "Bearer t" } });
  const res = await POST(bad, ctx);
  expect(res.status).toBe(200);
  expect(mockTrackEvent).toHaveBeenCalledWith("assistant.qr_code_exported", "u1", "ceo", { code_id: "c1", format: "unknown" });
});
