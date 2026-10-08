/** @jest-environment node */
/**
 * Contract for the Vercel integration OAuth callback: dark (501) until configured;
 * 400 on a missing code/project; typed failure -> mapped status; success -> event +
 * either a trusted redirect back to Vercel or a plain 200. Open-redirect defense:
 * an untrusted `next` is dropped. Lib + analytics mocked; no network.
 */
const configured = jest.fn();
const provision = jest.fn();
const trackEvent = jest.fn();

jest.mock("@/lib/forcefield-web/marketplace/vercel", () => ({
  isVercelIntegrationConfigured: () => configured(),
  provisionVercelProject: (...a: unknown[]) => provision(...a),
}));
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: unknown[]) => trackEvent(...a) }));

import { NextRequest } from "next/server";
import { GET } from "../route";

const base = "https://app.example/api/forcefield/integrations/vercel/callback";
const get = (qs: string) => GET(new NextRequest(`${base}${qs}`));

beforeEach(() => { jest.clearAllMocks(); configured.mockReturnValue(true); provision.mockResolvedValue({ ok: true, tenantId: "t1" }); });

it("is dark (501) until the integration is configured", async () => {
  configured.mockReturnValue(false);
  expect((await get("?code=c&projectId=p")).status).toBe(501);
  expect(provision).not.toHaveBeenCalled();
});

it("400 when code or project is missing", async () => {
  expect((await get("?projectId=p")).status).toBe(400);
  expect((await get("?code=c")).status).toBe(400);
  expect(provision).not.toHaveBeenCalled();
});

it("exchange failure maps to 401; other provision failure to 502", async () => {
  provision.mockResolvedValueOnce({ ok: false, reason: "exchange_failed" });
  expect((await get("?code=c&projectId=p")).status).toBe(401);
  provision.mockResolvedValueOnce({ ok: false, reason: "env_failed" });
  expect((await get("?code=c&projectId=p")).status).toBe(502);
});

it("success with no next -> 200 + provisioned event", async () => {
  const res = await get("?code=c&projectId=prj_1&site=acme");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, site: "acme", enforce: "off" });
  expect(trackEvent).toHaveBeenCalledWith("forcefield.integration_provisioned", "tenant:t1", "forcefield", { provider: "vercel", site: "acme" });
  // the exchange is handed the callback's own absolute redirect_uri
  expect(provision.mock.calls[0][0]).toMatchObject({ code: "c", projectId: "prj_1", siteLabel: "acme", redirectUri: `${base}` });
});

it("redirects to a Vercel-owned next (302)", async () => {
  const res = await get(`?code=c&projectId=p&next=${encodeURIComponent("https://vercel.com/integrations/complete")}`);
  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toBe("https://vercel.com/integrations/complete");
});

it("DROPS an untrusted next (open-redirect defense) and returns 200 instead", async () => {
  const res = await get(`?code=c&projectId=p&next=${encodeURIComponent("https://evil.example/steal")}`);
  expect(res.status).toBe(200); // not a 302 to evil
});
