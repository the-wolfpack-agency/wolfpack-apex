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
const mockRecordAudit = jest.fn().mockResolvedValue(undefined);

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
jest.mock("@/lib/audit-log", () => ({ recordAudit: (...a: unknown[]) => mockRecordAudit(...a) }));

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
      /* A deadline rides along now: the run stops on its own clock rather than
         being killed by the platform, which loses the report. */
      { limit: 10, deadline: expect.any(Number) },
    );
  });

  it("defaults the limit rather than repairing the whole library by surprise", async () => {
    await POST(req({}));
    expect(mockReprocess).toHaveBeenCalledWith(expect.any(Function), expect.anything(), {
      limit: 100,
      deadline: expect.any(Number),
    });
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

/**
 * The scheduled path.
 *
 * This repair was written for ninety Word documents that failed on a parser
 * bug fixed in #402. Measured 2026-08-27, it had never run. Zero events, and
 * every one of those documents was still unreadable months after the fix that
 * was supposed to rescue them.
 *
 * A repair that waits for somebody to remember it is a repair that does not
 * happen, so it now runs on a schedule. That adds an unauthenticated-looking
 * way into an admin route, which is what most of this block is about.
 */
describe("the cron path", () => {
  const cronReq = (auth: string, body?: unknown) =>
    ({
      headers: { get: (h: string) => (h.toLowerCase() === "authorization" ? auth : null) },
      json: async () => body ?? {},
      nextUrl: { searchParams: new URLSearchParams() },
    }) as never;

  const withSecret = (secret: string | undefined, fn: () => Promise<void>) => async () => {
    const saved = process.env.CRON_SECRET;
    if (secret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = secret;
    try {
      await fn();
    } finally {
      if (saved === undefined) delete process.env.CRON_SECRET;
      else process.env.CRON_SECRET = saved;
    }
  };

  it(
    "lets the scheduler in with the right secret, without a session",
    withSecret("s3cret", async () => {
      mockRequireCapability.mockResolvedValue({ ok: false, response: new Response(null, { status: 401 }) });
      const res = await GET(cronReq("Bearer s3cret"));
      expect(res.status).toBe(200);
      expect(mockRequireCapability).not.toHaveBeenCalled();
    }),
  );

  it(
    "refuses a wrong secret and falls back to the session gate",
    withSecret("s3cret", async () => {
      mockRequireCapability.mockResolvedValue({ ok: false, response: new Response(null, { status: 401 }) });
      const res = await GET(cronReq("Bearer wrong"));
      expect(res.status).toBe(401);
      expect(mockRequireCapability).toHaveBeenCalled();
    }),
  );

  /* THE ONE THAT MATTERS. With no secret configured, a bare "Bearer " must not
     become a way in. Local dev has no CRON_SECRET, and a comparison against an
     empty string would open the route to anyone. */
  it(
    "is not an open door when no secret is configured",
    withSecret(undefined, async () => {
      mockRequireCapability.mockResolvedValue({ ok: false, response: new Response(null, { status: 401 }) });
      for (const header of ["Bearer ", "Bearer undefined", ""]) {
        const res = await GET(cronReq(header));
        expect(res.status).toBe(401);
      }
    }),
  );

  it(
    "acts as the system rather than borrowing a person's identity",
    withSecret("s3cret", async () => {
      await POST(cronReq("Bearer s3cret", { limit: 5 }));
      /* The audit row for a scheduled repair must not name whoever last
         logged in. */
      const audited = mockRecordAudit.mock.calls.some(
        (c) => (c[0] as { actor?: { user_id?: string } })?.actor?.user_id === "cron",
      );
      expect(audited).toBe(true);
    }),
  );
});
