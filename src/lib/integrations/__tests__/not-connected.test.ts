/**
 * providerNotConnected() / connection-state: the one way a route says
 * "the provider is not connected". Never a 401 (that is the Instinct session).
 */
const mockTrackEvent = jest.fn();
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: unknown[]) => mockTrackEvent(...a),
}));

import { providerNotConnected, NOT_CONNECTED_ACTION_STATUS } from "@/lib/integrations/not-connected";
import { isProviderNotConnected, notConnectedBody } from "@/lib/integrations/connection-state";

const USER = { id: "u1", role: "ceo" };

beforeEach(() => mockTrackEvent.mockReset());

describe("providerNotConnected", () => {
  it("answers a read with 200 and keeps the route's empty data key", async () => {
    const res = providerNotConnected({ method: "GET" }, USER, "microsoft", {
      empty: { messages: [], nextSkip: null },
      surface: "emails/inbox",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      messages: [],
      nextSkip: null,
      connected: false,
      provider: "microsoft",
      error: "microsoft_not_connected",
      notice: expect.stringMatching(/Microsoft 365 is not connected/),
    });
  });

  it("treats HEAD as a read", () => {
    expect(providerNotConnected({ method: "HEAD" }, USER, "microsoft").status).toBe(200);
  });

  it.each(["POST", "PATCH", "PUT", "DELETE"])("answers %s with 409 and no data key", async (method) => {
    const res = providerNotConnected({ method }, USER, "microsoft", { empty: { task: null } });
    expect(res.status).toBe(NOT_CONNECTED_ACTION_STATUS);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).not.toHaveProperty("task");
    expect(body).toMatchObject({ connected: false, error: "microsoft_not_connected" });
  });

  it("never answers 401, for any method or provider", () => {
    for (const method of ["GET", "POST", "PATCH", "DELETE", undefined]) {
      for (const p of ["microsoft", "quickbooks", "plaud"] as const) {
        expect(providerNotConnected({ method }, USER, p).status).not.toBe(401);
      }
    }
  });

  it("does not let `notice` clobber a route's own `message` data key", async () => {
    const res = providerNotConnected({ method: "GET" }, USER, "microsoft", { empty: { message: null } });
    const body = await res.json();
    expect(body.message).toBeNull();
    expect(typeof body.notice).toBe("string");
  });

  it("records integration.not_connected_served with provider, method and surface", () => {
    providerNotConnected({ method: "POST" }, USER, "quickbooks", { surface: "x/y" });
    expect(mockTrackEvent).toHaveBeenCalledWith("integration.not_connected_served", "u1", "ceo", {
      provider: "quickbooks",
      method: "POST",
      surface: "x/y",
    });
  });

  it("records nothing when there is no user to attribute it to", () => {
    providerNotConnected({ method: "GET" }, null, "microsoft");
    expect(mockTrackEvent).not.toHaveBeenCalled();
  });
});

describe("isProviderNotConnected", () => {
  it("recognizes the current body", () => {
    expect(isProviderNotConnected(notConnectedBody("microsoft"))).toBe(true);
    expect(isProviderNotConnected({ chats: [], connected: false })).toBe(true);
  });
  it("recognizes the legacy { error: '<provider>_not_connected' } body across a deploy", () => {
    expect(isProviderNotConnected({ error: "microsoft_not_connected" })).toBe(true);
  });
  it("is false for a session 401, a scope 403, data, and non-objects", () => {
    expect(isProviderNotConnected({ error: "unauthorized" })).toBe(false);
    expect(isProviderNotConnected({ error: "forbidden", code: "scope_missing" })).toBe(false);
    expect(isProviderNotConnected({ messages: [] })).toBe(false);
    expect(isProviderNotConnected({ connected: true })).toBe(false);
    expect(isProviderNotConnected(null)).toBe(false);
    expect(isProviderNotConnected("microsoft_not_connected")).toBe(false);
  });
});
