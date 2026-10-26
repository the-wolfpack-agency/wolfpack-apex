/**
 * @jest-environment node
 *
 * Contract for GET /api/admin/forcefield/exposure: 401 / 403 (capability and
 * entitlement), 200 with the response shape (enabled flag, KEV catalog version,
 * scope line, mapped findings), and 200 with an explicit empty list. The store
 * is mocked (no DB); the query runs workspace-scoped.
 */
import { NextRequest, NextResponse } from "next/server";

const mockRequireCapability = jest.fn();
const mockEntitlement = jest.fn();
const mockList = jest.fn();
jest.mock("@/lib/auth/require-capability", () => ({ requireCapability: (...a: unknown[]) => mockRequireCapability(...a) }));
jest.mock("@/lib/tenancy/require-entitlement", () => ({ requireEntitlement: (...a: unknown[]) => mockEntitlement(...a) }));
jest.mock("@/lib/platform-scan/store", () => ({ listEdgeExposureFindings: (...a: unknown[]) => mockList(...a) }));

import { GET } from "../route";
import { KEV_SNAPSHOT } from "@/lib/forcefield/kev";

const OK_USER = { ok: true, user: { id: "u1", role: "admin", workspaceId: "w1" } };
const deny = (status: number) => ({ ok: false, response: new Response("{}", { status }) });
const req = () => new NextRequest("http://localhost/api/admin/forcefield/exposure");
const ROW = {
  id: "f1", scanId: "s1", platform: "client-x", route: "/", severity: "critical", category: "security",
  title: "Internet-facing portal with known-exploited CVEs", detail: "d", status: "open", createdAt: "2026-10-26T00:00:00.000Z",
  evidence: { exposure_kind: "edge_device", vendor: "Ivanti", product: "ivanti_connect_secure", cve_ids: "CVE-2025-0282, CVE-2024-21887", known_ransomware: true },
};

const ORIG = process.env.EDGE_EXPOSURE_ENABLED;
beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.EDGE_EXPOSURE_ENABLED;
  mockRequireCapability.mockResolvedValue(OK_USER);
  mockEntitlement.mockResolvedValue(null);
  mockList.mockResolvedValue([ROW]);
});
afterAll(() => {
  if (ORIG === undefined) delete process.env.EDGE_EXPOSURE_ENABLED;
  else process.env.EDGE_EXPOSURE_ENABLED = ORIG;
});

test("401 without a session", async () => {
  mockRequireCapability.mockResolvedValue(deny(401));
  expect((await GET(req())).status).toBe(401);
  expect(mockList).not.toHaveBeenCalled();
});

test("403 without settings.manage_team", async () => {
  mockRequireCapability.mockResolvedValue(deny(403));
  expect((await GET(req())).status).toBe(403);
});

test("403 without the forcefield entitlement", async () => {
  mockEntitlement.mockResolvedValue(NextResponse.json({ error: "not_entitled" }, { status: 403 }));
  expect((await GET(req())).status).toBe(403);
  expect(mockList).not.toHaveBeenCalled();
});

test("200 returns the workspace's mapped findings, the KEV version and the scope line", async () => {
  process.env.EDGE_EXPOSURE_ENABLED = "on";
  const res = await GET(req());
  expect(res.status).toBe(200);
  expect(mockList).toHaveBeenCalledWith("w1");
  const body = await res.json();
  expect(body.enabled).toBe(true);
  expect(body.kev.catalogVersion).toBe(KEV_SNAPSHOT.catalogVersion);
  expect(body.scope).toMatch(/does not protect them/);
  expect(body.findings[0]).toMatchObject({ id: "f1", vendor: "Ivanti", cveIds: ["CVE-2025-0282", "CVE-2024-21887"], knownRansomware: true, severity: "critical" });
  expect(body.findings[0]).not.toHaveProperty("evidence");
});

test("200 with an explicit empty list and enabled:false by default", async () => {
  mockList.mockResolvedValue([]);
  const res = await GET(req());
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toMatchObject({ enabled: false, findings: [] });
});
