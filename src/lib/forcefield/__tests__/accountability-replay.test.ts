import { replayAccountability, type ReplayRow } from "@/lib/forcefield/accountability-replay";

const row = (over: Partial<ReplayRow>): ReplayRow => ({
  type: "site.agent_flagged", path: "/login", site: "instinct", clientType: "scripted_library", hosting: "datacenter",
  authenticated: false, synthetic: false, identifiedAgent: false, principalStatus: null, principalScopes: [],
  accountability: null, wouldHold: null, ...over,
});

it("counts recorded verdicts by class and re-classifies older action-route hits", () => {
  const r = replayAccountability([
    row({ accountability: "browser_session", wouldHold: false, type: "site.action_observed" }),
    row({ accountability: "unaccountable", wouldHold: true }),
    row({}), // older script hit on /login
    row({ clientType: "browser", hosting: "residential", path: "/checkout/pay" }),
    row({ clientType: "unknown", identifiedAgent: true, principalStatus: "verified", principalScopes: ["/account"], path: "/account/x" }),
    row({ path: "/pricing" }), // not an action route
    row({ type: "site.page_viewed", path: "/login", clientType: "browser" }), // a read
    row({ type: "site.contact_submitted", path: "/contact" }),
    row({ synthetic: true }),
  ]);
  expect(r.rows).toBe(9);
  expect(r.recorded).toEqual({ browser_session: 1, signed_principal: 0, unaccountable: 1, wouldHold: 1 });
  expect(r.actionRouteHits).toEqual({ total: 3, browser_session: 1, signed_principal: 1, unaccountable: 1, wouldHold: 1 });
  expect(r.byKind).toEqual({ login: 1, checkout: 1, account: 1 });
  expect(r.siteReportedSubmissions).toBe(1);
  expect(r.syntheticExcluded).toBe(1);
});

it("prints counts only: no path, principal or fingerprint in the output", () => {
  const out = JSON.stringify(replayAccountability([row({ principalStatus: "verified", principalScopes: ["/secret-scope"], path: "/account/secret" })]));
  expect(out).not.toContain("secret");
});
