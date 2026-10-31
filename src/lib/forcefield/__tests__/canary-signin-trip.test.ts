/** @jest-environment node */
import { reportCanarySignIn, type CanaryTripEffects } from "@/lib/forcefield/canary-trip";

jest.mock("@/lib/db", () => ({ query: jest.fn(), safeQuery: jest.fn() }));
jest.mock("@/lib/site-analytics", () => ({ recordSiteEvent: jest.fn() }));
jest.mock("@/lib/forcefield/canary-store", () => ({ recordCanaryTrip: jest.fn() }));
jest.mock("@/lib/forcefield/blocked-fingerprints", () => ({ autoBlockFingerprint: jest.fn() }));

const fx = (found: unknown): CanaryTripEffects => ({
  find: jest.fn(async () => found) as never,
  trip: jest.fn(async () => ({ tracked: 1, audited: true, alert: null })) as never,
  event: jest.fn(async () => undefined) as never,
  block: jest.fn(async () => 1) as never,
});
const HIT = { id: "c1", workspaceId: "ws", username: "svc_sync_abcdef", seededIn: "login:site=ogiam.com;decoy=/_ff/registry-x;sig=566d7b8a", origin: { site: "ogiam.com", decoy: "/_ff/registry-x", sig: "566d7b8a" } };

it("a username without the canary shape is never looked up", async () => {
  const f = fx(HIT);
  expect(await reportCanarySignIn({ site: "s", username: "admin" }, f)).toBe(false);
  expect(f.find).not.toHaveBeenCalled();
});

it("a shaped username that is not ours records nothing", async () => {
  const f = fx(null);
  expect(await reportCanarySignIn({ site: "s", username: "svc_sync_zzzzzz" }, f)).toBe(false);
  expect(f.trip).not.toHaveBeenCalled();
  expect(f.event).not.toHaveBeenCalled();
});

it("a canary sign-in: the trip, a decoy event naming WHERE it was planted, and the fingerprint blocked", async () => {
  const f = fx(HIT);
  expect(await reportCanarySignIn({ site: "weekendwithporsche", username: HIT.username, path: "/admin/login", fp: "abc:unknown", sig: "s9" }, f)).toBe(true);
  expect(f.trip).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws", site: "weekendwithporsche", hits: [expect.objectContaining({ canaryId: "c1", kind: "login" })] }));
  expect(f.event).toHaveBeenCalledWith(expect.objectContaining({
    eventType: "site.agent_trap_tripped",
    path: "/admin/login",
    props: expect.objectContaining({ site: "weekendwithporsche", reason: "canary_login", canary: true, canary_origin_site: "ogiam.com", canary_origin_decoy: "/_ff/registry-x", canary_origin_sig: "566d7b8a", fp: "abc:unknown" }),
  }));
  expect(f.block).toHaveBeenCalledWith("abc:unknown", "honeytoken");
});

it("without a fingerprint nothing is blocked; a failing step never throws", async () => {
  const f = fx(HIT);
  (f.event as jest.Mock).mockRejectedValue(new Error("db"));
  expect(await reportCanarySignIn({ site: "s", username: HIT.username }, f)).toBe(true);
  expect(f.block).not.toHaveBeenCalled();
});
