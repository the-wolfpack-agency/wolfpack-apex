/**
 * The reprocess trigger: the gate, the dry run, and honest failure.
 *
 * A repair endpoint that anybody can POST is a way to hammer Graph and rewrite
 * a document library, so the gate is asserted as 401/403/200 rather than "not
 * 500". GET exists so the operator can see what a run would do before running
 * it, which matters when the run costs a download per document.
 */

const mockRequireCapability = jest.fn();
const mockFind = jest.fn();
const mockReprocess = jest.fn();
const mockQuery = jest.fn();
const mockDownload = jest.fn();

jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: (...a: unknown[]) => mockRequireCapability(...a),
}));
jest.mock("@/lib/brain/reprocess", () => ({
  findCandidates: (...a: unknown[]) => mockFind(...a),
  reprocessFixable: (...a: unknown[]) => mockReprocess(...a),
}));
jest.mock("@/lib/connectors/sharepoint/sync", () => ({
  downloadDriveItem: (...a: unknown[]) => mockDownload(...a),
}));
jest.mock("@/lib/db", () => ({ query: (...a: unknown[]) => mockQuery(...a) }));

import { GET, POST } from "../route";

const req = (body?: unknown) =>
  ({
    headers: { get: () => "Bearer t" },
    json: async () => body ?? {},
    nextUrl: { searchParams: new URLSearchParams() },
  }) as never;

beforeEach(() => {
  jest.clearAllMocks();
  mockRequireCapability.mockResolvedValue({ ok: true, user: { id: "u1", role: "cto" } });
  mockQuery.mockResolvedValue({ rows: [{ id: "s1", drive_id: "drive-1" }] });
  mockFind.mockResolvedValue([
    { id: "d1", filename: "SOW.docx", reason: "docx_mimetype", driveItemId: "i1" },
    { id: "d2", filename: "x.xlsx", reason: "extractor_now_exists", driveItemId: "i2" },
  ]);
  mockReprocess.mockResolvedValue({
    considered: 2, attempted: 2, repaired: 2, stillFailing: 0, skippedNoDriveItem: 0, outcomes: [],
  });
});

describe("the gate", () => {
  it("401s an unauthenticated caller on both verbs", async () => {
    mockRequireCapability.mockResolvedValue({
      ok: false,
      response: { status: 401, json: async () => ({ error: "unauthorized" }) },
    });
    expect((await GET(req())).status).toBe(401);
    expect((await POST(req())).status).toBe(401);
  });

  it("gates on the capability, not on a role string", async () => {
    await GET(req());
    expect(mockRequireCapability).toHaveBeenCalledWith(expect.anything(), "settings.manage_team");
  });

  it("403s a role that may not repair the library", async () => {
    mockRequireCapability.mockResolvedValue({
      ok: false,
      response: { status: 403, json: async () => ({ error: "forbidden" }) },
    });
    expect((await GET(req())).status).toBe(403);
    expect((await POST(req())).status).toBe(403);
  });

  it("does not run a repair for a forbidden caller", async () => {
    mockRequireCapability.mockResolvedValue({
      ok: false,
      response: { status: 403, json: async () => ({ error: "forbidden" }) },
    });
    await POST(req());
    expect(mockReprocess).not.toHaveBeenCalled();
  });
});

describe("the dry run", () => {
  it("reports what a run would do, grouped by reason, without repairing", async () => {
    const body = await (await GET(req())).json();
    expect(body).toMatchObject({ readable: true, candidates: 2 });
    expect(body.byReason).toEqual({ docx_mimetype: 1, extractor_now_exists: 1 });
    expect(mockReprocess).not.toHaveBeenCalled();
  });

  it("says unreadable rather than reporting zero candidates when the query fails", async () => {
    mockFind.mockRejectedValue(new Error("db down"));
    const body = await (await GET(req())).json();
    expect(body.readable).toBe(false);
    expect(body.candidates).toBeUndefined();
  });
});

describe("the run", () => {
  it("returns the repair report", async () => {
    const body = await (await POST(req({ limit: 10 }))).json();
    expect(body).toMatchObject({ ok: true, repaired: 2, stillFailing: 0 });
    expect(mockReprocess).toHaveBeenCalledWith(
      expect.any(Function),
      { userId: "u1", role: "cto" },
      { limit: 10 },
    );
  });

  it("defaults the limit rather than repairing the whole library by surprise", async () => {
    await POST(req({}));
    expect(mockReprocess).toHaveBeenCalledWith(expect.any(Function), expect.anything(), { limit: 100 });
  });

  it("downloads on the caller's own token, never a shared one", async () => {
    await POST(req({}));
    const fetchBytes = mockReprocess.mock.calls[0][0] as (id: string) => Promise<unknown>;
    await fetchBytes("item-9");
    expect(mockDownload).toHaveBeenCalledWith("u1", "drive-1", "item-9");
  });

  it("returns no bytes rather than throwing when no drive is configured", async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await POST(req({}));
    const fetchBytes = mockReprocess.mock.calls[0][0] as (id: string) => Promise<unknown>;
    await expect(fetchBytes("item-9")).resolves.toBeNull();
  });

  it("500s with the reason when the repair itself throws", async () => {
    mockReprocess.mockRejectedValue(new Error("graph down"));
    const res = await POST(req({}));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toContain("graph down");
  });
});
