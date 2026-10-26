/**
 * @jest-environment node
 *
 * Contract for the tenant-notify cron: 401 with CRON_SECRET set and a wrong
 * bearer, 200 with the run report, 200 ok:false (not 500) when the run throws.
 */
const mockRun = jest.fn();
jest.mock("@/lib/forcefield-web/tenant-alerts", () => ({
  runTenantNotifications: (...a: unknown[]) => mockRun(...a),
  liveTenantNotifyDeps: () => ({}),
}));

import { GET } from "../route";

const ORIG = process.env.CRON_SECRET;
afterEach(() => { if (ORIG === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = ORIG; jest.clearAllMocks(); });

it("401 when CRON_SECRET is set and the bearer is wrong", async () => {
  process.env.CRON_SECRET = "s3cret-value";
  const res = await GET(new Request("http://x/api/cron/forcefield-tenant-notify", { headers: { authorization: "Bearer nope" } }));
  expect(res.status).toBe(401);
  expect(mockRun).not.toHaveBeenCalled();
});

it("200 with the report on the right bearer", async () => {
  process.env.CRON_SECRET = "s3cret-value";
  mockRun.mockResolvedValueOnce({ tenants: 2, firstEvidence: 1, alertsDispatched: 3, alertsDelivered: 3, digests: 0, blocked: 0 });
  const res = await GET(new Request("http://x/api/cron/forcefield-tenant-notify", { headers: { authorization: "Bearer s3cret-value" } }));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, tenants: 2, firstEvidence: 1, alertsDispatched: 3, alertsDelivered: 3, digests: 0, blocked: 0 });
});

it("200 ok:false (never 500) when the run throws", async () => {
  delete process.env.CRON_SECRET;
  mockRun.mockRejectedValueOnce(new Error("db down"));
  const res = await GET(new Request("http://x/api/cron/forcefield-tenant-notify"));
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ ok: false, error: "run_failed" });
});
