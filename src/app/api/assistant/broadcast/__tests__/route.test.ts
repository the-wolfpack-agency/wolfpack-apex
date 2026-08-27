/**
 * Contract for the broadcast endpoint.
 *
 * The status codes carry the meaning here, so they are what is asserted. The
 * one that matters most is 503: an unreadable recipient list must not come
 * back as a successful send of zero, because a sender who is told "delivered"
 * will not send it again, and the company never hears the thing.
 */
const mockRequire = jest.fn();
const mockBroadcast = jest.fn();

jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: (...a: unknown[]) => mockRequire(...a),
}));
jest.mock("@/lib/assistant/broadcast", () => ({
  broadcastToAssistants: (...a: unknown[]) => mockBroadcast(...a),
  MAX_BROADCAST_CHARS: 2000,
}));

import { POST } from "@/app/api/assistant/broadcast/route";

function req(body: unknown): never {
  return {
    json: async () => body,
    url: "http://localhost/api/assistant/broadcast",
    headers: new Headers(),
  } as never;
}

const allow = {
  ok: true,
  user: { id: "u1", role: "cto", workspaceId: "ws1", email: "", name: "" },
  capabilities: new Set(["settings.manage_team"]),
};

beforeEach(() => {
  jest.clearAllMocks();
  mockRequire.mockResolvedValue(allow);
  mockBroadcast.mockResolvedValue({ delivered: 3, failed: 0, readable: true, redacted: [] });
});

describe("authorization", () => {
  it("is gated on acting for the team", async () => {
    await POST(req({ message: "hello" }));
    expect(mockRequire).toHaveBeenCalledWith(expect.anything(), "settings.manage_team");
  });

  it("returns the guard's own refusal untouched", async () => {
    const refusal = new Response(null, { status: 403 });
    mockRequire.mockResolvedValue({ ok: false, response: refusal });
    const res = await POST(req({ message: "hello" }));
    expect(res.status).toBe(403);
    expect(mockBroadcast).not.toHaveBeenCalled();
  });
});

describe("input", () => {
  it("rejects an empty message", async () => {
    const res = await POST(req({ message: "   " }));
    expect(res.status).toBe(400);
    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  it("rejects a message over the limit", async () => {
    const res = await POST(req({ message: "x".repeat(2001) }));
    expect(res.status).toBe(400);
    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  it("rejects a body that is not JSON", async () => {
    const bad = {
      json: async () => {
        throw new Error("not json");
      },
      url: "http://localhost/api/assistant/broadcast",
      headers: new Headers(),
    } as never;
    expect((await POST(bad)).status).toBe(400);
  });

  it("sends the workspace and actor from the session, never from the body", async () => {
    await POST(req({ message: "hello", workspaceId: "attacker-ws", actorId: "someone-else" }));
    expect(mockBroadcast).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws1", actorId: "u1", actorRole: "cto" }),
    );
  });
});

describe("outcomes", () => {
  it("returns 200 when everybody was written to", async () => {
    const res = await POST(req({ message: "hello" }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ delivered: 3, failed: 0 });
  });

  it("returns 207 when some recipients failed, rather than pretending it was clean", async () => {
    mockBroadcast.mockResolvedValue({ delivered: 2, failed: 1, readable: true, redacted: [] });
    const res = await POST(req({ message: "hello" }));
    expect(res.status).toBe(207);
    await expect(res.json()).resolves.toMatchObject({ delivered: 2, failed: 1 });
  });

  /* The one that matters. A sender told "delivered" will not send again. */
  it("returns 503 when the recipient list could not be read", async () => {
    mockBroadcast.mockResolvedValue({ delivered: 0, failed: 0, readable: false, redacted: [] });
    const res = await POST(req({ message: "hello" }));
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({ error: "recipients_unreadable" });
  });

  it("reports what was redacted, so the sender knows the text changed", async () => {
    mockBroadcast.mockResolvedValue({
      delivered: 1, failed: 0, readable: true, redacted: ["card_number"],
    });
    const res = await POST(req({ message: "hello" }));
    await expect(res.json()).resolves.toMatchObject({ redacted: ["card_number"] });
  });
});
