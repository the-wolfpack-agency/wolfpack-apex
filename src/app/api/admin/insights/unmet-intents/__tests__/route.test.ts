/**
 * /api/admin/insights/unmet-intents — admin-gated read endpoint for
 * the unmet-intent backlog. Pins the auth contract + the response
 * envelope shape so a future caller (admin dashboard) can rely on
 * `intents[].normalizedText` etc.
 */

const mockGetUnmet = jest.fn();
const mockTrackEvent = jest.fn();

jest.mock("@/lib/insights/unmet-intents", () => ({
  getUnmetIntents: (...a: unknown[]) => mockGetUnmet(...a),
}));
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: unknown[]) => mockTrackEvent(...a),
}));

const CTO_USER = { id: "u1", role: "cto", name: "Nick", email: "n@x.co" };
let currentUser: { id: string; role: string; name: string; email: string } | null = CTO_USER;
jest.mock("@/lib/auth", () => ({
  getUserFromRequest: () => currentUser,
}));

import { NextRequest } from "next/server";
import { GET } from "../route";

function get(url = "https://x.test/api/admin/insights/unmet-intents"): NextRequest {
  return new NextRequest(url, { method: "GET", headers: { authorization: "Bearer x" } });
}

beforeEach(() => {
  mockGetUnmet.mockReset();
  mockTrackEvent.mockReset();
  currentUser = CTO_USER;
});

describe("GET /api/admin/insights/unmet-intents", () => {
  test("401 when unauthenticated", async () => {
    currentUser = null;
    const res = await GET(get());
    expect(res.status).toBe(401);
  });

  test("403 when role is not cto/ceo/evp", async () => {
    currentUser = { id: "u2", role: "dev", name: "Dev", email: "d@x.co" };
    const res = await GET(get());
    expect(res.status).toBe(403);
  });

  test("returns the intent list + clamps query params", async () => {
    mockGetUnmet.mockResolvedValue([
      {
        normalizedText: "show my deals",
        exampleText: "Show my deals",
        count: 4,
        lastSeenAt: "2026-05-17T10:00:00Z",
        distinctUsers: 3,
        brainContextRate: 0.25,
      },
    ]);
    const res = await GET(get("https://x.test/api/admin/insights/unmet-intents?since=999999&limit=9999&minLen=0"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sinceHours).toBe(720); // clamped to 30 days
    expect(body.limit).toBe(500);
    expect(body.minLength).toBe(1);
    expect(body.intents[0].normalizedText).toBe("show my deals");
    expect(mockGetUnmet).toHaveBeenCalledWith(
      expect.objectContaining({ sinceHours: 720, limit: 500, minLength: 1 }),
    );
  });

  test("defaults: 168h window, 50 rows", async () => {
    mockGetUnmet.mockResolvedValue([]);
    await GET(get());
    expect(mockGetUnmet).toHaveBeenCalledWith(
      expect.objectContaining({ sinceHours: 168, limit: 50, minLength: 6 }),
    );
  });

  test("fires audit-log analytics on success", async () => {
    mockGetUnmet.mockResolvedValue([]);
    await GET(get());
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "system.audit_log_viewed",
      "u1",
      "cto",
      expect.objectContaining({ view: "insights.unmet_intents" }),
    );
  });
});
