/**
 * Contract for the agent stop button.
 *
 * The assertions worth reading are about the two things a kill switch must
 * never do: guess which way the operator meant to move it, and report failure
 * when it actually moved.
 */
const mockRead = jest.fn();
const mockSet = jest.fn();
const mockAudit = jest.fn();
let mockAuth: () => Promise<unknown> = async () => ({
  ok: true,
  user: { id: "cto-1", role: "cto", workspaceId: "ws-1" },
});

jest.mock("@/lib/auth/require-capability", () => ({ requireCapability: () => mockAuth() }));
jest.mock("@/lib/containment/state", () => ({
  readContainmentState: (...a: unknown[]) => mockRead(...a),
  setAgentsEnabled: (...a: unknown[]) => mockSet(...a),
}));
jest.mock("@/lib/audit-log", () => ({
  recordAudit: (...a: unknown[]) => mockAudit(...a),
  extractRequestMetadata: () => ({}),
}));

import { NextRequest } from "next/server";
import { GET, POST } from "../route";

const post = (body: unknown) =>
  new NextRequest("http://localhost/api/admin/containment", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });

beforeEach(() => {
  jest.clearAllMocks();
  mockAuth = async () => ({ ok: true, user: { id: "cto-1", role: "cto", workspaceId: "ws-1" } });
  mockRead.mockResolvedValue({ agentsEnabled: true, readable: true });
  mockSet.mockResolvedValue(undefined);
  mockAudit.mockResolvedValue(undefined);
});

describe("stopping", () => {
  it("flips the switch and reports the state that resulted", async () => {
    mockRead.mockResolvedValue({ agentsEnabled: false, readable: true });
    const res = await POST(post({ enabled: false, reason: "suspicious egress" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ agentsEnabled: false, readable: true });
    expect(mockSet).toHaveBeenCalledWith("ws-1", false, expect.objectContaining({ reason: "suspicious egress" }));
  });

  it("succeeds with no reason given, because a hurry is not a form error", async () => {
    // An operator halting agents mid-incident must never be blocked by a
    // validation message.
    const res = await POST(post({ enabled: false }));
    expect(res.status).toBe(200);
    expect(mockSet).toHaveBeenCalled();
  });

  it("still reports success when the audit write fails", async () => {
    // The switch has already moved. Telling the operator their stop failed,
    // when it did not, is the worst possible answer here.
    mockAudit.mockRejectedValue(new Error("ledger down"));
    mockRead.mockResolvedValue({ agentsEnabled: false, readable: true });
    const res = await POST(post({ enabled: false }));
    expect(res.status).toBe(200);
    expect(mockSet).toHaveBeenCalled();
  });

  it("records who stopped it and why, to the audit log", async () => {
    await POST(post({ enabled: false, reason: "runaway loop" }));
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "containment.agents_stopped",
        actor: { user_id: "cto-1", role: "cto" },
      }),
    );
  });

  it("caps an absurdly long reason rather than storing it whole", async () => {
    await POST(post({ enabled: false, reason: "x".repeat(5000) }));
    expect((mockSet.mock.calls[0][2] as { reason: string }).reason.length).toBe(500);
  });
});

describe("it never guesses which way to move", () => {
  it.each([{}, { enabled: "false" }, { enabled: 0 }, { enabled: null }])("rejects %p with 400", async (body) => {
    // A default here would mean a malformed request could stop, or resume,
    // agent work. That is the one place a helpful default is indefensible.
    const res = await POST(post(body));
    expect(res.status).toBe(400);
    expect(mockSet).not.toHaveBeenCalled();
  });

  it("rejects a malformed body with 400 rather than 500", async () => {
    const req = new NextRequest("http://localhost/api/admin/containment", {
      method: "POST",
      body: "{not json",
      headers: { "content-type": "application/json" },
    });
    expect((await POST(req)).status).toBe(400);
    expect(mockSet).not.toHaveBeenCalled();
  });

  it("rejects a non-string reason", async () => {
    expect((await POST(post({ enabled: false, reason: 42 }))).status).toBe(400);
  });
});

describe("resuming", () => {
  it("turns agents back on and audits it as a resume, not a stop", async () => {
    await POST(post({ enabled: true }));
    expect(mockSet).toHaveBeenCalledWith("ws-1", true, expect.any(Object));
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "containment.agents_resumed" }));
  });
});

describe("reading the state", () => {
  it("reports stopped and unreadable as DIFFERENT facts", async () => {
    // They look identical to an operator otherwise, and only one of them means
    // a person made a decision. The other means the database is unhealthy.
    mockRead.mockResolvedValue({ agentsEnabled: false, readable: false });
    const body = await (await GET(new NextRequest("http://localhost/api/admin/containment"))).json();
    expect(body).toMatchObject({ agentsEnabled: false, readable: false });
  });

  it("returns 200 with the current state", async () => {
    const res = await GET(new NextRequest("http://localhost/api/admin/containment"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ workspaceId: "ws-1", agentsEnabled: true });
  });
});

describe("authorization", () => {
  it("returns 401 to an unauthenticated caller, and does not touch the switch", async () => {
    mockAuth = async () => ({ ok: false, response: new Response(null, { status: 401 }) });
    expect((await POST(post({ enabled: false }))).status).toBe(401);
    expect(mockSet).not.toHaveBeenCalled();
  });

  it("returns 401 on the read as well", async () => {
    mockAuth = async () => ({ ok: false, response: new Response(null, { status: 401 }) });
    expect((await GET(new NextRequest("http://localhost/api/admin/containment"))).status).toBe(401);
  });
});
