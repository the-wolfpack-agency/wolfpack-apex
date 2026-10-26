/** @jest-environment node */
/**
 * Contract: the central engine scores INTENT per session and returns the
 * step-up. Record-only unless FORCEFIELD_INTENT_ENFORCE=on; a tarpit is
 * returned as action "tarpit" + delayMs (an older shim treats it as allow).
 */
const recordSiteEvent = jest.fn();
const trackEvent = jest.fn();
const getIntentCarryover = jest.fn();
jest.mock("@/lib/site-analytics", () => ({ recordSiteEvent: (...a: unknown[]) => recordSiteEvent(...a) }));
jest.mock("@/lib/forcefield/blocked-fingerprints", () => ({ getBlockedFingerprints: async () => [] }));
jest.mock("@/lib/forcefield/datacenter-ranges", () => ({ getDatacenterPrefixes: async () => [] }));
jest.mock("@/lib/forcefield/crawler-ranges", () => ({ getCrawlerRanges: async () => ({}) }));
jest.mock("@/lib/forcefield-web/billing", () => ({ getSiteBlockEntitlement: async () => null, entitledToBlock: (l: boolean | null) => l !== false }));
jest.mock("@/lib/forcefield-web/tenants", () => ({ resolveTenantByToken: async () => null }));
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: unknown[]) => trackEvent(...a) }));
jest.mock("@/lib/forcefield/canary-store", () => ({ checkInboundForCanaries: async () => ({ tripped: false, hits: [], severity: "none" }) }));
jest.mock("@/lib/forcefield/intent-carryover", () => ({ getIntentCarryover: (...a: unknown[]) => getIntentCarryover(...a) }));

import { NextRequest } from "next/server";
import { POST } from "../route";
import { _resetIntentLedger } from "@/lib/forcefield-web/monitor";

const OLD = process.env;
beforeEach(() => {
  jest.clearAllMocks();
  _resetIntentLedger();
  process.env = { ...OLD, FORCEFIELD_EDGE_TOKEN: "secret-token" };
  delete process.env.FORCEFIELD_INTENT_ENFORCE;
  recordSiteEvent.mockResolvedValue(undefined);
  getIntentCarryover.mockResolvedValue([]);
});
afterAll(() => { process.env = OLD; });

let ipN = 1;
const post = (body: Record<string, unknown>) =>
  new NextRequest("http://localhost/api/forcefield/observe", {
    method: "POST",
    headers: { "content-type": "application/json", "x-edge-token": "secret-token" },
    body: JSON.stringify(body),
  });
const recon = (path: string, ip: string) => ({ site: "instinct", path, method: "GET", userAgent: "python-requests/2.31", headerNames: ["host", "user-agent"], country: "US", ip, stack: ["nextjs"] });

test("record-only by default: 200 allow, the step-up is recorded with its reasons", async () => {
  const ip = `192.0.2.${ipN++}`;
  expect((await (await POST(post(recon("/bitrix/a", ip)))).json()).action).toBe("allow");
  const res = await POST(post(recon("/bitrix/b", ip)));
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ action: "allow" });
  const intents = recordSiteEvent.mock.calls.map((c) => c[0]).filter((e) => e.eventType === "site.intent_scored");
  expect(intents.map((e) => e.props.intent_action)).toEqual(["watch", "tarpit"]);
  expect(intents[1].props).toMatchObject({ intent_applied: false, intent_details: "bitrix" });
  expect(trackEvent).toHaveBeenCalledWith("forcefield.intent_decided", "site:instinct", "forcefield", expect.objectContaining({ action: "tarpit", applied: false }));
  expect(JSON.stringify(recordSiteEvent.mock.calls)).not.toContain(ip);
});

test("FORCEFIELD_INTENT_ENFORCE=on returns tarpit + delayMs, never a block on intent alone", async () => {
  process.env.FORCEFIELD_INTENT_ENFORCE = "on";
  const ip = `192.0.2.${ipN++}`;
  await POST(post(recon("/bitrix/a", ip)));
  const body = await (await POST(post(recon("/bitrix/b", ip)))).json();
  expect(body).toMatchObject({ action: "tarpit", wouldBlock: false });
  expect(body.delayMs).toBeGreaterThan(0);
});

test("a decoy taken turns the same client's follow-on requests away with reasonKind intent", async () => {
  process.env.FORCEFIELD_INTENT_ENFORCE = "on";
  const ip = `192.0.2.${ipN++}`;
  expect((await (await POST(post(recon("/_ff/records", ip)))).json()).reasonKind).toBe("decoy");
  expect(await (await POST(post(recon("/pricing", ip)))).json()).toMatchObject({ action: "block", reasonKind: "intent" });
});

test("a WordPress-declared site requesting its own wp-admin is not scored", async () => {
  const ip = `192.0.2.${ipN++}`;
  for (const p of ["/wp-admin/", "/wp-login.php", "/wp-json/wp/v2/posts"]) await POST(post({ ...recon(p, ip), stack: ["wordpress"] }));
  expect(recordSiteEvent.mock.calls.some((c) => c[0].eventType === "site.intent_scored")).toBe(false);
});
