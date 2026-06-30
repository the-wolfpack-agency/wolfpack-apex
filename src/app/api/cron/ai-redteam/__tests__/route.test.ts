/**
 * Contract tests for GET /api/cron/ai-redteam. The two auth paths (CRON_SECRET
 * bearer vs admin capability vs 401), the healthy-run body, and that a wrong
 * bearer falls through to the capability gate (no secret bypass). execute mocked.
 */

export {};

const mockRequireCapability = jest.fn();
const mockExecute = jest.fn();

jest.mock("@/lib/auth/require-capability", () => ({ requireCapability: (...a: unknown[]) => mockRequireCapability(...a) }));
jest.mock("@/lib/ai-redteam/execute", () => ({ executeRedTeam: (...a: unknown[]) => mockExecute(...a) }));

import { NextRequest, NextResponse } from "next/server";
import { GET } from "../route";

const cleanReport = { attacksRun: 8, blocked: 8, vulns: [], passRate: 1, byCategory: {} };
const breachedReport = { attacksRun: 8, blocked: 7, vulns: [{ attackId: "x", category: "LLM06_info_disclosure", technique: "t", outcome: "allow", ruleId: "R" }], passRate: 0.875, byCategory: {} };
const req = (auth?: string) => new NextRequest("https://x.test/api/cron/ai-redteam", { method: "GET", headers: auth ? { authorization: auth } : {} });
const deny = (s: number) => ({ ok: false, response: NextResponse.json({ error: "no" }, { status: s }) });

beforeEach(() => {
  jest.resetAllMocks();
  mockExecute.mockResolvedValue({ report: cleanReport, id: "art_x" });
  delete process.env.CRON_SECRET;
});

test("401 with neither a valid cron secret nor an authorized session", async () => {
  mockRequireCapability.mockResolvedValue(deny(401));
  expect((await GET(req())).status).toBe(401);
  expect(mockExecute).not.toHaveBeenCalled();
});

test("cron path: runs as the system actor and reports healthy", async () => {
  process.env.CRON_SECRET = "s3cret";
  const res = await GET(req("Bearer s3cret"));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toMatchObject({ ok: true, runId: "art_x", vulns: 0, healthy: true });
  expect(mockExecute).toHaveBeenCalledWith(expect.objectContaining({ source: "cron", actorId: "cron", actorRole: "system" }));
  expect(mockRequireCapability).not.toHaveBeenCalled();
});

test("a wrong bearer falls through to the capability gate (no secret bypass)", async () => {
  process.env.CRON_SECRET = "s3cret";
  mockRequireCapability.mockResolvedValue(deny(403));
  expect((await GET(req("Bearer WRONG"))).status).toBe(403);
  expect(mockRequireCapability).toHaveBeenCalledWith(expect.anything(), "settings.manage_team");
});

test("a regression (vulns > 0) is reported as unhealthy", async () => {
  process.env.CRON_SECRET = "s3cret";
  mockExecute.mockResolvedValue({ report: breachedReport, id: "art_y" });
  const body = await (await GET(req("Bearer s3cret"))).json();
  expect(body).toMatchObject({ vulns: 1, healthy: false });
});
