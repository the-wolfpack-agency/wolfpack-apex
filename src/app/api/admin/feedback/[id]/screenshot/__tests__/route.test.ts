/**
 * Contract tests for GET /api/admin/feedback/[id]/screenshot.
 *
 * The endpoint serves the raster image a teammate attached to a feedback
 * note. It is capability gated (settings.manage_team) and workspace scoped:
 * a cross-tenant id returns 404 exactly like a missing one, so it leaks
 * nothing about other workspaces. The bytes come back with nosniff + a
 * restrictive CSP so the stream can never be reinterpreted as anything but
 * an image.
 *
 * Mocks: requireCapability (the gate), @/lib/db query (the ownership check),
 *        and getFeedbackScreenshot (the stored bytes).
 */

export {};

const mockRequireCap = jest.fn();
jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: (...a: unknown[]) => mockRequireCap(...a),
}));

const mockQuery = jest.fn();
jest.mock("@/lib/db", () => ({
  query: (...a: unknown[]) => mockQuery(...a),
}));

const mockGetScreenshot = jest.fn();
jest.mock("@/lib/feedback/screenshot-store", () => ({
  getFeedbackScreenshot: (...a: unknown[]) => mockGetScreenshot(...a),
}));

const CTO = { id: "u_cto", email: "cto@x.com", role: "cto", workspaceId: "default" };

function mkReq(): any {
  return { url: "http://x/api/admin/feedback/fb-1/screenshot", headers: new Headers() };
}
function mkParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("GET /api/admin/feedback/[id]/screenshot", () => {
  test("401 when requireCapability denies (no DB or store access)", async () => {
    mockRequireCap.mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }),
    });
    const { GET } = await import("@/app/api/admin/feedback/[id]/screenshot/route");
    const res = await GET(mkReq(), mkParams("fb-1"));
    expect(res.status).toBe(401);
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockGetScreenshot).not.toHaveBeenCalled();
  });

  test("404 when the feedback row is not in the caller's workspace", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    // Ownership check returns no rows -> cross-tenant or missing id.
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const { GET } = await import("@/app/api/admin/feedback/[id]/screenshot/route");
    const res = await GET(mkReq(), mkParams("fb-other-ws"));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("not_found");
    // Ownership is enforced before fetching any bytes.
    expect(mockGetScreenshot).not.toHaveBeenCalled();
    // The ownership query is scoped by id AND workspace_id.
    expect(mockQuery.mock.calls[0][1]).toEqual(["fb-other-ws", "default"]);
  });

  test("404 no_screenshot when the row exists but has no image", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    mockQuery.mockResolvedValueOnce({ rows: [{ id: "fb-1" }] });
    mockGetScreenshot.mockResolvedValueOnce(null);
    const { GET } = await import("@/app/api/admin/feedback/[id]/screenshot/route");
    const res = await GET(mkReq(), mkParams("fb-1"));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("no_screenshot");
  });

  test("200 returns the decoded bytes with the stored content type + nosniff + CSP", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    mockQuery.mockResolvedValueOnce({ rows: [{ id: "fb-1" }] });
    const payload = "screenshot-bytes-here";
    const dataBase64 = Buffer.from(payload).toString("base64");
    mockGetScreenshot.mockResolvedValueOnce({
      contentType: "image/png",
      dataBase64,
      byteSize: payload.length,
    });

    const { GET } = await import("@/app/api/admin/feedback/[id]/screenshot/route");
    const res = await GET(mkReq(), mkParams("fb-1"));

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Content-Security-Policy")).toMatch(/default-src 'none'/);
    expect(res.headers.get("Cache-Control")).toMatch(/private/);

    // The body is the decoded image bytes, not the base64 text.
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.toString()).toBe(payload);
  });
});
