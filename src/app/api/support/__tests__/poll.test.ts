/**
 * GET /api/support/poll — auth + dispatch tests.
 *
 * Covers both the cron path (bearer CRON_SECRET) and the user path
 * (capability check). The poll itself is mocked — pollSupportInbox is
 * unit-tested separately in src/lib/support/__tests__/inbox-poller.test.ts.
 */

import { NextRequest } from "next/server";

jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: jest.fn(),
}));
jest.mock("@/lib/support/inbox-poller", () => ({
  pollSupportInbox: jest.fn(),
}));
jest.mock("@/lib/analytics", () => ({
  trackEvent: jest.fn(),
}));

const { requireCapability } = jest.requireMock("@/lib/auth/require-capability");
const { pollSupportInbox } = jest.requireMock("@/lib/support/inbox-poller");

const user = { id: "u-1", email: "op@x.com", role: "dev" };

function unauth() {
  return {
    ok: false,
    response: new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
    }) as unknown as Response,
  };
}

function forbidden() {
  return {
    ok: false,
    response: new Response(JSON.stringify({ error: "forbidden" }), {
      status: 403,
    }) as unknown as Response,
  };
}

function authed() {
  return { ok: true, user, capabilities: new Set() };
}

function reqWithBearer(bearer: string | null): NextRequest {
  const headers: Record<string, string> = {};
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  return new NextRequest("http://t/api/support/poll", {
    method: "GET",
    headers,
  });
}

const happyResult = {
  source: "support-inbox" as const,
  mailbox: "support@thewolfpack.agency",
  messages_seen: 3,
  tickets_created: 2,
  replies_appended: 1,
  drafts_generated: 2,
  errors: 0,
  duration_ms: 12,
};

describe("GET /api/support/poll", () => {
  beforeEach(() => {
    /* `resetAllMocks` (not `clearAllMocks`) is required so queued
       `mockResolvedValueOnce`/`mockRejectedValueOnce` results from a
       previous test do not bleed into the next one. */
    jest.resetAllMocks();
    delete process.env.CRON_SECRET;
  });

  it("cron path: 200 when CRON_SECRET matches", async () => {
    process.env.CRON_SECRET = "shh";
    process.env.AUTOMATION_POLL_USER_ID = "automation-cron";
    pollSupportInbox.mockResolvedValueOnce(happyResult);

    const { GET } = await import("../poll/route");
    const res = await GET(reqWithBearer("shh"));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.result.tickets_created).toBe(2);
    expect(pollSupportInbox).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "automation-cron", userRole: "ops" }),
    );
    /* requireCapability MUST NOT be called when the cron bearer matches. */
    expect(requireCapability).not.toHaveBeenCalled();
  });

  it("cron path: 401 when bearer is wrong (falls through to capability path)", async () => {
    process.env.CRON_SECRET = "shh";
    requireCapability.mockResolvedValue(unauth());
    pollSupportInbox.mockResolvedValueOnce(happyResult);

    const { GET } = await import("../poll/route");
    const res = await GET(reqWithBearer("wrong-bearer"));

    expect(res.status).toBe(401);
    expect(pollSupportInbox).not.toHaveBeenCalled();
  });

  it("user path: 200 when capability check succeeds", async () => {
    requireCapability.mockResolvedValue(authed());
    pollSupportInbox.mockResolvedValueOnce(happyResult);

    const { GET } = await import("../poll/route");
    const res = await GET(reqWithBearer("user-token"));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(pollSupportInbox).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "u-1", userRole: "dev" }),
    );
  });

  it("user path: 403 when capability check forbids", async () => {
    requireCapability.mockResolvedValue(forbidden());

    const { GET } = await import("../poll/route");
    const res = await GET(reqWithBearer("user-token"));

    expect(res.status).toBe(403);
    expect(pollSupportInbox).not.toHaveBeenCalled();
  });

  it("returns 500 with error when pollSupportInbox throws", async () => {
    requireCapability.mockResolvedValue(authed());
    pollSupportInbox.mockRejectedValueOnce(new Error("db unreachable"));

    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const { GET } = await import("../poll/route");
    const res = await GET(reqWithBearer("user-token"));

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/db unreachable/);
    errSpy.mockRestore();
  });
});
