/**
 * @jest-environment node
 *
 * Contract for POST /api/admin/forcefield/grid. The seeder behavior is proven
 * in deception-grid unit tests; this asserts the ROUTE: auth (401/403),
 * entitlement gate, delegation to ensureDeceptionGrid, and that the grid action
 * is audited. Deps mocked so the contract needs no database.
 */
import { NextRequest } from "next/server";

const mockRequireCapability = jest.fn();
const mockRequireEntitlement = jest.fn();
const mockEnsureGrid = jest.fn();
const mockRecordAudit = jest.fn();

jest.mock("@/lib/auth/require-capability", () => ({ requireCapability: (...a: unknown[]) => mockRequireCapability(...a) }));
jest.mock("@/lib/tenancy/require-entitlement", () => ({ requireEntitlement: (...a: unknown[]) => mockRequireEntitlement(...a) }));
jest.mock("@/lib/forcefield/deception-grid", () => ({ ensureDeceptionGrid: (...a: unknown[]) => mockEnsureGrid(...a) }));
jest.mock("@/lib/audit-log", () => ({ recordAudit: (...a: unknown[]) => mockRecordAudit(...a) }));

import { POST } from "@/app/api/admin/forcefield/grid/route";

const OK = { ok: true, user: { id: "u1", role: "cto", workspaceId: "w1" }, capabilities: new Set(["settings.manage_team"]) };
const req = () => new NextRequest("http://localhost/api/admin/forcefield/grid", { method: "POST" });

beforeEach(() => { [mockRequireCapability, mockRequireEntitlement, mockEnsureGrid, mockRecordAudit].forEach((m) => m.mockReset()); mockRequireEntitlement.mockResolvedValue(null); });

describe("POST /api/admin/forcefield/grid", () => {
  it("403 when the capability gate denies", async () => {
    mockRequireCapability.mockResolvedValue({ ok: false, response: new Response("forbidden", { status: 403 }) });
    expect((await POST(req())).status).toBe(403);
    expect(mockEnsureGrid).not.toHaveBeenCalled();
  });

  it("403 when the workspace lacks the forcefield entitlement", async () => {
    mockRequireCapability.mockResolvedValue(OK);
    mockRequireEntitlement.mockResolvedValueOnce(new Response("no entitlement", { status: 403 }));
    expect((await POST(req())).status).toBe(403);
    expect(mockEnsureGrid).not.toHaveBeenCalled();
  });

  it("seeds the grid for the caller's workspace and audits the action", async () => {
    mockRequireCapability.mockResolvedValue(OK);
    mockEnsureGrid.mockResolvedValue({ seeded: [{ kind: "row", placement: "..." }, { kind: "tool", placement: "..." }], alreadyPresent: ["token", "route"], pendingPlacement: [] });
    const res = await POST(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.seeded.map((s: { kind: string }) => s.kind)).toEqual(["row", "tool"]);
    expect(mockEnsureGrid).toHaveBeenCalledWith({ workspaceId: "w1", createdBy: "u1" });
    expect(mockRecordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "forcefield.grid_seeded", resourceId: "w1" }));
  });
});
