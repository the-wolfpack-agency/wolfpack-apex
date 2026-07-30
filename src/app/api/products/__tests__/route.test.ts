/**
 * Contract tests for /api/products.
 *
 * Asserts the auth gate (200/401) and that the learning hook fires
 * (analytics trackEvent). The catalog itself is curated code, so the route only
 * gates access + records the view; there is no write path.
 */

import { NextRequest } from "next/server";

const mockRequireCapability = jest.fn();
jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: (...a: unknown[]) => mockRequireCapability(...a),
}));

const mockTrackEvent = jest.fn();
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: unknown[]) => mockTrackEvent(...a) }));

import { GET } from "../route";
import { NextResponse } from "next/server";

const USER = { id: "u1", role: "member" };

function authorize() {
  mockRequireCapability.mockResolvedValue({ ok: true, user: USER });
}
function deny(status: number) {
  mockRequireCapability.mockResolvedValue({
    ok: false,
    response: NextResponse.json({ error: "no" }, { status }),
  });
}
function req(): NextRequest {
  return new NextRequest("https://x.test/api/products", {
    method: "GET",
    headers: { authorization: "Bearer x" },
  });
}

beforeEach(() => jest.clearAllMocks());

describe("GET /api/products", () => {
  test("200 returns the full catalog and fires analytics", async () => {
    authorize();
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.products)).toBe(true);
    expect(body.products.length).toBeGreaterThan(0);
    // Every product has the fields the UI relies on.
    for (const p of body.products) {
      expect(typeof p.id).toBe("string");
      expect(typeof p.name).toBe("string");
      expect(typeof p.summary).toBe("string");
      expect(Array.isArray(p.highlights)).toBe(true);
      expect(Array.isArray(p.potentialUses)).toBe(true);
      expect(typeof p.status).toBe("string");
    }
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "products.viewed",
      "u1",
      "member",
      expect.objectContaining({ count: body.products.length }),
    );
  });

  test("gate enforced on demand: requests products.view", async () => {
    authorize();
    await GET(req());
    expect(mockRequireCapability).toHaveBeenCalledWith(expect.anything(), "products.view");
  });

  test("401 when unauthorized, and no analytics fires", async () => {
    deny(401);
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(mockTrackEvent).not.toHaveBeenCalled();
  });

  test("403 when forbidden", async () => {
    deny(403);
    const res = await GET(req());
    expect(res.status).toBe(403);
  });
});
