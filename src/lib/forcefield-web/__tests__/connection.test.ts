/**
 * Unit test for getTenantConnection: three honest states (connected = recent
 * traffic, everConnected = wired at some point, lastEventAt), scoped by tenant id,
 * never throws. The clock is injected so recency is deterministic. No DB.
 */
import { getTenantConnection, CONNECTION_FRESH_WINDOW_MS } from "../public-stats";

const NOW = Date.parse("2026-10-07T12:00:00Z");

it("connected=true for a RECENT event (within the freshness window)", async () => {
  const q = jest.fn().mockResolvedValueOnce([{ last_event_at: "2026-10-07T11:00:00Z" }]);
  const r = await getTenantConnection("t-1", q, NOW);
  expect(r).toEqual({ connected: true, everConnected: true, lastEventAt: "2026-10-07T11:00:00Z" });
  expect(q.mock.calls[0][1]).toEqual(["t-1"]); // scoped to the tenant
  expect(q.mock.calls[0][0]).toMatch(/forcefield_tenant_id = \$1/);
});

it("STALE: everConnected but NOT connected when the last event is older than the window", async () => {
  const old = new Date(NOW - CONNECTION_FRESH_WINDOW_MS - 60_000).toISOString();
  const r = await getTenantConnection("t-1", jest.fn().mockResolvedValueOnce([{ last_event_at: old }]), NOW);
  expect(r.connected).toBe(false); // went quiet -> not a false "Connected"
  expect(r.everConnected).toBe(true); // but it WAS wired
  expect(r.lastEventAt).toBe(old);
});

it("never connected when no events have arrived", async () => {
  const q = jest.fn().mockResolvedValueOnce([{ last_event_at: null }]);
  expect(await getTenantConnection("t-1", q, NOW)).toEqual({ connected: false, everConnected: false, lastEventAt: null });
});

it("never throws - a query error degrades to disconnected", async () => {
  const q = jest.fn().mockRejectedValueOnce(new Error("db"));
  expect(await getTenantConnection("t-1", q, NOW)).toEqual({ connected: false, everConnected: false, lastEventAt: null });
});
