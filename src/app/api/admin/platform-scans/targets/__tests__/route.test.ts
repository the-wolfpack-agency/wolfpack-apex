/**
 * Contract for GET /api/admin/platform-scans/targets — the scan targets that
 * populate the platform selector. Gated on settings.manage_team.
 */
const mockList = jest.fn();
let mockAuth: () => Promise<unknown> = async () => ({ ok: true, user: { id: "a", role: "admin", workspaceId: "ws-1" } });

jest.mock("@/lib/auth/require-capability", () => ({ requireCapability: () => mockAuth() }));
jest.mock("@/lib/platform-scan/manifests", () => ({ listScanTargets: (...a: unknown[]) => mockList(...a) }));

import { NextRequest } from "next/server";
import { GET } from "@/app/api/admin/platform-scans/targets/route";

beforeEach(() => {
  jest.clearAllMocks();
  mockAuth = async () => ({ ok: true, user: { id: "a", role: "admin", workspaceId: "ws-1" } });
  mockList.mockResolvedValue([{ platform: "wolfpack-auto", baseUrl: "https://x", hasStatic: true }]);
});

it("returns the scan targets (manifests + connections) for the workspace", async () => {
  const res = await GET(new NextRequest("http://localhost/api/admin/platform-scans/targets"));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ targets: [{ platform: "wolfpack-auto", baseUrl: "https://x", hasStatic: true }] });
  expect(mockList).toHaveBeenCalledWith("ws-1");
});

it("403s when the capability gate fails", async () => {
  mockAuth = async () => ({ ok: false, response: new Response(null, { status: 403 }) });
  const res = await GET(new NextRequest("http://localhost/api/admin/platform-scans/targets"));
  expect(res.status).toBe(403);
  expect(mockList).not.toHaveBeenCalled();
});
