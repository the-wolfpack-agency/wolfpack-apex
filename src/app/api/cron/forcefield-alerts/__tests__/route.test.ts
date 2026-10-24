/**
 * Contract for the forcefield-alerts cron: CRON_SECRET gate (401), job
 * validation (400), the 200 report shape (scan + delivery outcome + silence
 * check), and the never-throw 200 with ok:false on a scan failure. There is no
 * role on a cron bearer, so there is no 403 path.
 */
const mockScan = jest.fn();
const mockSilence = jest.fn();
const mockIsSilenceHour = jest.fn();
jest.mock("@/lib/forcefield-web/alerts", () => ({
  scanForcefieldWebAlerts: (...a: unknown[]) => mockScan(...a),
  runAlertSilenceCheck: (...a: unknown[]) => mockSilence(...a),
  isSilenceCheckHour: (...a: unknown[]) => mockIsSilenceHour(...a),
  liveForcefieldAlertDeps: () => ({}),
}));

import { GET } from "../route";

const ENV = { ...process.env };
const URL_BASE = "http://x/api/cron/forcefield-alerts";
const auth = { headers: { authorization: "Bearer s3cret" } };

beforeEach(() => {
  process.env.CRON_SECRET = "s3cret";
  mockScan.mockReset().mockResolvedValue({ detected: 2, dispatched: 1, delivered: 1, failed: 0 });
  mockSilence.mockReset().mockResolvedValue({ hostileEvents: 5, deliveredAlerts: 0, silent: true, alert: { status: "delivered" } });
  mockIsSilenceHour.mockReset().mockReturnValue(false);
});
afterEach(() => { process.env = { ...ENV }; });

it("401 on an unauthorized call when CRON_SECRET is set", async () => {
  const res = await GET(new Request(URL_BASE));
  expect(res.status).toBe(401);
  expect(mockScan).not.toHaveBeenCalled();
});

it("400 on an unknown job", async () => {
  const res = await GET(new Request(`${URL_BASE}?job=nope`, auth));
  expect(res.status).toBe(400);
  expect((await res.json()).ok).toBe(false);
  expect(mockScan).not.toHaveBeenCalled();
});

it("200 with the scan's delivery outcome; no silence check outside its hour", async () => {
  const res = await GET(new Request(URL_BASE, auth));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toMatchObject({ ok: true, detected: 2, dispatched: 1, delivered: 1, failed: 0, silence: { checked: false } });
  expect(mockSilence).not.toHaveBeenCalled();
});

it("runs the daily silence check during its hour, alongside the scan", async () => {
  mockIsSilenceHour.mockReturnValue(true);
  const body = await (await GET(new Request(URL_BASE, auth))).json();
  expect(mockScan).toHaveBeenCalledTimes(1);
  expect(body.silence).toEqual({ checked: true, silent: true, hostileEvents: 5, deliveredAlerts: 0, alert: "delivered" });
});

it("?job=silence runs only the silence check", async () => {
  const body = await (await GET(new Request(`${URL_BASE}?job=silence`, auth))).json();
  expect(mockScan).not.toHaveBeenCalled();
  expect(mockSilence).toHaveBeenCalledTimes(1);
  expect(body.silence.checked).toBe(true);
});

it("a scan failure still returns 200 (schedule keeps running) but says ok:false", async () => {
  mockScan.mockRejectedValue(new Error("db down"));
  const res = await GET(new Request(URL_BASE, auth));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.ok).toBe(false);
  expect(body.error).toBe("scan_failed");
});
