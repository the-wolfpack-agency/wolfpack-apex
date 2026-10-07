/**
 * Unit test for getTenantConnection: maps the latest event timestamp to a
 * connected flag, scopes by tenant id, and never throws (degrades to
 * disconnected). No DB: the query fn is injected.
 */
import { getTenantConnection } from "../public-stats";

it("connected=true with the last-event time when the tenant has events", async () => {
  const q = jest.fn().mockResolvedValueOnce([{ last_event_at: "2026-10-07T00:00:00Z" }]);
  const r = await getTenantConnection("t-1", q);
  expect(r).toEqual({ connected: true, lastEventAt: "2026-10-07T00:00:00Z" });
  // scoped to the tenant id
  expect(q.mock.calls[0][1]).toEqual(["t-1"]);
  expect(q.mock.calls[0][0]).toMatch(/forcefield_tenant_id = \$1/);
});

it("connected=false when no events have arrived", async () => {
  const q = jest.fn().mockResolvedValueOnce([{ last_event_at: null }]);
  expect(await getTenantConnection("t-1", q)).toEqual({ connected: false, lastEventAt: null });
});

it("never throws - a query error degrades to disconnected", async () => {
  const q = jest.fn().mockRejectedValueOnce(new Error("db"));
  expect(await getTenantConnection("t-1", q)).toEqual({ connected: false, lastEventAt: null });
});
