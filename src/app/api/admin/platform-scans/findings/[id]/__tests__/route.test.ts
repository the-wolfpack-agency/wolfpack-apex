/**
 * Contract for POST /api/admin/platform-scans/findings/[id] (triage one finding).
 * Gated on settings.manage_team; body status must be acknowledged|resolved.
 * The store is mocked so the route's auth + validation + workspace wiring is
 * exercised without a DB.
 */
const mockTriage = jest.fn();
let mockAuth: () => Promise<unknown> = async () => ({
  ok: true,
  user: { id: "admin-1", role: "admin", workspaceId: "ws-1" },
});

jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: () => mockAuth(),
}));
jest.mock("@/lib/platform-scan/store", () => ({
  triageFinding: (...a: unknown[]) => mockTriage(...a),
}));

import { NextRequest } from "next/server";
import { POST } from "@/app/api/admin/platform-scans/findings/[id]/route";

function post(status: unknown, id = "f-1") {
  const req = new NextRequest(
    `http://localhost/api/admin/platform-scans/findings/${id}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status }),
    },
  );
  return POST(req, { params: Promise.resolve({ id }) });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAuth = async () => ({
    ok: true,
    user: { id: "admin-1", role: "admin", workspaceId: "ws-1" },
  });
  mockTriage.mockResolvedValue({ id: "f-1", status: "acknowledged" });
});

it("triages a finding with a valid status (200) attributed to the admin", async () => {
  const res = await post("acknowledged");
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({
    ok: true,
    finding: { id: "f-1", status: "acknowledged" },
  });
  expect(mockTriage).toHaveBeenCalledWith(
    "f-1",
    "ws-1",
    "acknowledged",
    "admin-1",
    "admin",
  );
});

it("accepts 'resolved' as well", async () => {
  mockTriage.mockResolvedValue({ id: "f-1", status: "resolved" });
  const res = await post("resolved");
  expect(res.status).toBe(200);
  expect(mockTriage).toHaveBeenCalledWith(
    "f-1",
    "ws-1",
    "resolved",
    "admin-1",
    "admin",
  );
});

it("400s an invalid status with no store call", async () => {
  const res = await post("nuke");
  expect(res.status).toBe(400);
  expect(mockTriage).not.toHaveBeenCalled();
});

it("404s when the finding is not found / wrong workspace", async () => {
  mockTriage.mockResolvedValue(null);
  const res = await post("resolved");
  expect(res.status).toBe(404);
});

it("403s when the capability gate fails (no triage)", async () => {
  mockAuth = async () => ({
    ok: false,
    response: new Response(null, { status: 403 }),
  });
  const res = await post("acknowledged");
  expect(res.status).toBe(403);
  expect(mockTriage).not.toHaveBeenCalled();
});
