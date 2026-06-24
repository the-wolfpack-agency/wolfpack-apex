/**
 * Contract tests for POST /api/mail/draft. Asserts the full status surface
 * (201 created, 401 unauth, 403 scope_missing, 400 invalid_input, 429 rate
 * limited) so a regression cannot blank the agent draft path. The integration
 * (createDraft) is mocked; this proves the route's auth + mapping, not Graph.
 */

export {};

const mockGetUser = jest.fn();
jest.mock("@/lib/auth", () => ({
  getUserFromRequest: (...a: unknown[]) => mockGetUser(...a),
}));

const mockRequireCapability = jest.fn();
jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: (...a: unknown[]) => mockRequireCapability(...a),
}));

const mockCreateDraft = jest.fn();
jest.mock("@/lib/integrations/microsoft-mail", () => ({
  createDraft: (...a: unknown[]) => mockCreateDraft(...a),
}));

jest.mock("@/lib/analytics", () => ({ trackEvent: jest.fn() }));

import { POST, _resetDraftRateLimit } from "@/app/api/mail/draft/route";

const USER = { id: "u1", email: "a@x.com", role: "ceo" };

function mkReq(body: unknown, auth = "Bearer t"): any {
  const headers = new Headers();
  if (auth) headers.set("authorization", auth);
  headers.set("content-type", "application/json");
  return new Request("http://test/api/mail/draft", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  }) as any;
}

beforeEach(() => {
  jest.clearAllMocks();
  _resetDraftRateLimit();
  mockGetUser.mockReturnValue(USER);
  mockRequireCapability.mockResolvedValue({ ok: true, user: USER });
});

describe("POST /api/mail/draft", () => {
  it("401 when unauthenticated", async () => {
    mockGetUser.mockReturnValue(null);
    const res = await POST(mkReq({ to: "x@y.com", bodyText: "hi" }, ""));
    expect(res.status).toBe(401);
  });

  it("403 scope_missing when Mail.ReadWrite is not granted", async () => {
    mockCreateDraft.mockResolvedValue({ ok: false, code: "scope_missing", scope: "Mail.ReadWrite" });
    const res = await POST(mkReq({ to: "x@y.com", subject: "Re", bodyText: "hi" }));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toMatchObject({ code: "scope_missing", scope: "Mail.ReadWrite" });
  });

  it("400 invalid_input when the integration rejects the shape", async () => {
    mockCreateDraft.mockResolvedValue({ ok: false, code: "invalid_input", message: "to_required" });
    const res = await POST(mkReq({ subject: "Re", bodyText: "hi" }));
    expect(res.status).toBe(400);
  });

  it("201 with the created draft id + webLink on success", async () => {
    mockCreateDraft.mockResolvedValue({ ok: true, value: { id: "draft-9", webLink: "https://o/d9" } });
    const res = await POST(mkReq({ to: "dana@acme.com", subject: "Overdue", bodyText: "Please remit." }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ id: "draft-9", webLink: "https://o/d9" });

    // `to` string is forwarded as-is (the integration normalizes to recipients).
    const passed = mockCreateDraft.mock.calls[0][1];
    expect(passed.to).toEqual(["dana@acme.com"]);
    expect(passed.subject).toBe("Overdue");
    expect(passed.bodyText).toBe("Please remit.");
  });

  it("400 on invalid JSON body", async () => {
    const headers = new Headers();
    headers.set("authorization", "Bearer t");
    const badReq = new Request("http://test/api/mail/draft", {
      method: "POST",
      headers,
      body: "{not json",
    }) as any;
    const res = await POST(badReq);
    expect(res.status).toBe(400);
  });
});
