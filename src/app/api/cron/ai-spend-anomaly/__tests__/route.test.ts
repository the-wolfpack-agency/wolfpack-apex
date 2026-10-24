/**
 * Contract for the ai-spend-anomaly cron: CRON_SECRET gate (fail closed),
 * 200 with the scan result, and a degraded 200 (never a 500) on a read failure.
 */
const mockQuery = jest.fn();
const mockTrackEventAwait = jest.fn();
const mockFanoutToTeam = jest.fn();
jest.mock("@/lib/db", () => ({ query: (...a: unknown[]) => mockQuery(...a) }));
jest.mock("@/lib/analytics", () => ({ trackEventAwait: (...a: unknown[]) => mockTrackEventAwait(...a) }));
jest.mock("@/lib/notifications/team-fanout", () => ({ fanoutToTeam: (...a: unknown[]) => mockFanoutToTeam(...a) }));

import { GET } from "../route";

const ENV = { ...process.env };
const URL = "http://x/api/cron/ai-spend-anomaly";
const authed = () => new Request(URL, { headers: { authorization: "Bearer s3cret" } });

beforeEach(() => {
  jest.clearAllMocks();
  process.env = { ...ENV, CRON_SECRET: "s3cret" };
});
afterAll(() => {
  process.env = { ...ENV };
});

it("401 without an Authorization header", async () => {
  const res = await GET(new Request(URL));
  expect(res.status).toBe(401);
  expect(mockQuery).not.toHaveBeenCalled();
});

it("401 with the wrong secret", async () => {
  const res = await GET(new Request(URL, { headers: { authorization: "Bearer nope" } }));
  expect(res.status).toBe(401);
  expect(mockQuery).not.toHaveBeenCalled();
});

it("401 (fail closed) when CRON_SECRET is unset, even with a bearer", async () => {
  delete process.env.CRON_SECRET;
  const res = await GET(new Request(URL, { headers: { authorization: "Bearer " } }));
  expect(res.status).toBe(401);
});

it("200 with a valid secret: scans, alerts a spike once, and reports the counts", async () => {
  mockQuery
    .mockResolvedValueOnce({
      rows: [
        { bucket: "__unattributed__", last24h_usd: "24", last24h_calls: "826", trailing_usd: "18.14", trailing_calls: "3000" },
        { bucket: "ws_quiet", last24h_usd: "0.3", last24h_calls: "10", trailing_usd: "2", trailing_calls: "70" },
      ],
    })
    .mockResolvedValueOnce({ rows: [] });
  const res = await GET(authed());
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toMatchObject({ ok: true, scanned: 2, detected: 1, dispatched: 1, alreadyAlerted: 0 });
  expect(mockTrackEventAwait).toHaveBeenCalledWith(
    "ai.spend_anomaly_detected",
    "system",
    "system",
    expect.objectContaining({ bucket: "__unattributed__", reason: "spike" }),
  );
  expect(mockFanoutToTeam).toHaveBeenCalledTimes(1);
});

it("200 and NO second alert when the bucket was already alerted today", async () => {
  mockQuery
    .mockResolvedValueOnce({
      rows: [{ bucket: "ws_a", last24h_usd: "50", last24h_calls: "100", trailing_usd: "7", trailing_calls: "70" }],
    })
    .mockResolvedValueOnce({ rows: [{ bucket: "ws_a" }] });
  const res = await GET(authed());
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ ok: true, detected: 1, dispatched: 0, alreadyAlerted: 1 });
  expect(mockTrackEventAwait).not.toHaveBeenCalled();
  expect(mockFanoutToTeam).not.toHaveBeenCalled();
});

it("200 with no anomalies and an empty bucket list", async () => {
  mockQuery.mockResolvedValueOnce({ rows: [] });
  const res = await GET(authed());
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ ok: true, scanned: 0, detected: 0, dispatched: 0 });
});

it("a failed read is a DEGRADED 200, never a 500 and never a fake clean scan", async () => {
  const err = jest.spyOn(console, "error").mockImplementation(() => undefined);
  mockQuery.mockRejectedValueOnce(new Error("db down"));
  const res = await GET(authed());
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ ok: true, degraded: true, dispatched: 0 });
  err.mockRestore();
});
