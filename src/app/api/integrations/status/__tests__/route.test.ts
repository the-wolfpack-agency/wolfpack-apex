/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * /api/integrations/status — aggregate integration-connection endpoint.
 *
 * Locks the contract the Tasks + Planner pages rely on:
 *   { microsoft: { connected: boolean, ... },
 *     quickbooks: { connected: boolean, ... },
 *     plaud: { connected: boolean, configured: boolean } }
 *
 * The bug this catches: endpoint didn't exist → fetch 404 →
 * setMsConnected(false) → "Connect Microsoft To Do" empty state for
 * users who had in fact connected successfully.
 */

const mockMs = jest.fn();
const mockQb = jest.fn();
const mockPlaudStatus = jest.fn();
const mockPlaudConfigured = jest.fn();

jest.mock("@/lib/microsoft-graph", () => ({
  getConnectionStatus: (...a: any[]) => mockMs(...a),
}));
jest.mock("@/lib/quickbooks", () => ({
  getConnectionStatus: (...a: any[]) => mockQb(...a),
}));
jest.mock("@/lib/plaud", () => ({
  getConnectionStatus: (...a: any[]) => mockPlaudStatus(...a),
  isPlaudConfigured: (...a: any[]) => mockPlaudConfigured(...a),
}));

const AUTH_USER = { id: "u1", role: "ceo", name: "Nick", email: "n@x.co" };
jest.mock("@/lib/auth", () => ({
  getUserFromRequest: () => AUTH_USER,
}));

import { NextRequest } from "next/server";
import { GET } from "../route";

function get(url = "https://x.test/api/integrations/status"): NextRequest {
  return new NextRequest(url, {
    method: "GET",
    headers: { authorization: "Bearer x" },
  });
}

beforeEach(() => {
  mockMs.mockReset();
  mockQb.mockReset();
  mockPlaudStatus.mockReset();
  mockPlaudConfigured.mockReset();
  mockPlaudConfigured.mockReturnValue(false);
});

describe("GET /api/integrations/status", () => {
  test("returns the aggregate shape Tasks + Planner expect", async () => {
    mockMs.mockResolvedValue({
      connected: true,
      userEmail: "u@x.co",
      displayName: "U",
      lastSync: "2026-04-21T00:00:00Z",
      mode: "live",
    });
    mockQb.mockResolvedValue({ connected: false });
    mockPlaudStatus.mockResolvedValue({ connected: false });

    const res = await GET(get());
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.microsoft.connected).toBe(true);
    expect(data.microsoft.userEmail).toBe("u@x.co");
    expect(data.quickbooks.connected).toBe(false);
    expect(data.plaud.connected).toBe(false);
    expect(data.plaud.configured).toBe(false);
  });

  test("passes the caller's user id to the Microsoft status lookup (per-user tokens)", async () => {
    mockMs.mockResolvedValue({ connected: false, mode: "live" });
    mockQb.mockResolvedValue({ connected: false });
    mockPlaudStatus.mockResolvedValue({ connected: false });

    await GET(get());
    expect(mockMs).toHaveBeenCalledWith(AUTH_USER.id);
  });

  test("swallows per-provider failures so one broken integration can't blank the dashboard", async () => {
    mockMs.mockRejectedValue(new Error("db down"));
    mockQb.mockResolvedValue({ connected: true });
    mockPlaudStatus.mockRejectedValue(new Error("plaud api down"));

    const res = await GET(get());
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.microsoft.connected).toBe(false);
    expect(data.quickbooks.connected).toBe(true);
    expect(data.plaud.connected).toBe(false);
  });

  test("401 when unauthenticated", async () => {
    jest.resetModules();
    jest.doMock("@/lib/auth", () => ({ getUserFromRequest: () => null }));
    jest.doMock("@/lib/microsoft-graph", () => ({
      getConnectionStatus: () => Promise.resolve({ connected: false }),
    }));
    jest.doMock("@/lib/quickbooks", () => ({
      getConnectionStatus: () => Promise.resolve({ connected: false }),
    }));
    jest.doMock("@/lib/plaud", () => ({
      getConnectionStatus: () => Promise.resolve({ connected: false }),
      isPlaudConfigured: () => false,
    }));
    const { GET: FreshGET } = await import("../route");
    const res = await FreshGET(get());
    expect(res.status).toBe(401);
  });
});
