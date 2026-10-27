import {
  DEFAULT_STATE_CHANGE_RULES,
  accountabilityVerdict,
  applyPrincipalToAction,
  coerceActionProps,
  coerceStateChangeRules,
  stateChangeOf,
  type AccountabilityInput,
} from "@/lib/forcefield-web/accountability";
import { observeRequest, withEnforcement } from "@/lib/forcefield-web/observe";
import { DEFAULT_RULESET, coerceRuleset } from "@/lib/forcefield-web/ruleset";
import { stampPrincipal } from "@/lib/forcefield/action-accountability";

const BROWSER_HEADERS = ["host", "user-agent", "accept", "accept-language", "accept-encoding", "sec-fetch-site", "sec-fetch-mode", "origin"];
const CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const base = { site: "instinct", country: "US", nowMs: 1_758_000_000_000 };

const input = (over: Partial<AccountabilityInput> = {}): AccountabilityInput => ({
  clientType: "browser",
  headerMismatch: false,
  hosting: "residential",
  authenticated: false,
  headerNames: BROWSER_HEADERS,
  identifiedAgent: false,
  ...over,
});

describe("stateChangeOf - which requests are actions (ruleset data)", () => {
  const sc = (path: string, method: string, site = "instinct", staticAsset = false) => stateChangeOf({ site, path, method, staticAsset });

  it("treats POST/PUT/PATCH/DELETE on a non-static path as an action", () => {
    expect(sc("/contact-us", "POST")).toEqual({ kind: "form", method: "POST" });
    expect(sc("/api/items/1", "DELETE")).toEqual({ kind: "api", method: "DELETE" });
    expect(sc("/api/items/1", "patch")).toEqual({ kind: "api", method: "PATCH" });
  });

  it("names the configured action routes", () => {
    expect(sc("/login", "POST")?.kind).toBe("login");
    expect(sc("/wp-login.php", "POST")?.kind).toBe("login");
    expect(sc("/checkout/pay", "POST")?.kind).toBe("checkout");
    expect(sc("/register", "POST")?.kind).toBe("signup");
    expect(sc("/my-account/edit", "PUT")?.kind).toBe("account");
  });

  it("counts a GET data export, but not a GET of the login page", () => {
    expect(stateChangeOf({ site: "x", path: "/export/customers", method: "GET", staticAsset: false })).toEqual({ kind: "export", method: "GET" });
    expect(sc("/login", "GET")).toBeNull();
    expect(sc("/pricing", "GET")).toBeNull();
  });

  it("never counts static assets, telemetry or the Forcefield control plane", () => {
    expect(sc("/logo.png", "POST", "instinct", true)).toBeNull();
    expect(sc("/api/site-analytics/ingest", "POST")).toBeNull();
    expect(sc("/api/forcefield/observe", "POST")).toBeNull();
  });

  it("honors per-site routes before the shared ones", () => {
    const rules = { ...DEFAULT_STATE_CHANGE_RULES, siteRoutes: { shop: [{ pattern: "/basket", kind: "checkout" }] } };
    expect(stateChangeOf({ site: "shop", path: "/basket/add", method: "POST", staticAsset: false }, rules)?.kind).toBe("checkout");
    expect(stateChangeOf({ site: "other", path: "/basket/add", method: "POST", staticAsset: false }, rules)?.kind).toBe("form");
  });
});

describe("accountabilityVerdict", () => {
  it("browser: a real browser with Fetch Metadata is a browser session, never held", () => {
    expect(accountabilityVerdict(input())).toEqual({ class: "browser_session", reason: "browser_signals", wouldHold: false });
  });

  it("browser: a session the site attested is accountable even without browser signals", () => {
    expect(accountabilityVerdict(input({ clientType: "scripted_library", authenticated: true }))).toEqual({ class: "browser_session", reason: "site_attested_session", wouldHold: false });
  });

  it("signed agent inside its mandate: signed_principal, within, not held", () => {
    expect(accountabilityVerdict(input({ clientType: "unknown", identifiedAgent: true, principal: { status: "verified", withinMandate: true } }))).toEqual({
      class: "signed_principal", reason: "verified_principal", wouldHold: false, mandate: "within",
    });
  });

  it("signed agent outside its mandate: signed_principal, outside, would hold", () => {
    expect(accountabilityVerdict(input({ clientType: "unknown", identifiedAgent: true, principal: { status: "verified", withinMandate: false } }))).toEqual({
      class: "signed_principal", reason: "verified_principal", wouldHold: true, mandate: "outside",
    });
  });

  it("plain script: unaccountable automation, would hold", () => {
    expect(accountabilityVerdict(input({ clientType: "scripted_library", headerNames: ["user-agent"] }))).toEqual({ class: "unaccountable", reason: "script_client", wouldHold: true });
    expect(accountabilityVerdict(input({ clientType: "unknown", headerNames: [] })).reason).toBe("script_client");
  });

  it("names the weaker browser failures separately, so the watch window can tune them", () => {
    expect(accountabilityVerdict(input({ headerNames: ["accept", "accept-language", "accept-encoding"] })).reason).toBe("no_fetch_metadata");
    expect(accountabilityVerdict(input({ hosting: "datacenter" })).reason).toBe("browser_from_datacenter");
    expect(accountabilityVerdict(input({ clientType: "unknown", headerMismatch: true })).reason).toBe("header_mismatch");
    expect(accountabilityVerdict(input({ clientType: "headless" })).reason).toBe("headless_browser");
  });

  it("a known agent or a claimed principal with no verified signature is unaccountable", () => {
    expect(accountabilityVerdict(input({ clientType: "known_crawler", identifiedAgent: true })).reason).toBe("agent_without_principal");
    expect(accountabilityVerdict(input({ principal: { status: "claimed" } })).reason).toBe("principal_unverified");
  });
});

describe("observeRequest records the verdict (watch mode, never a block)", () => {
  it("a browser form POST is recorded as site.action_observed with no session key", () => {
    const o = observeRequest({ ...base, path: "/contact", method: "POST", userAgent: CHROME, headerNames: BROWSER_HEADERS }, DEFAULT_RULESET)!;
    expect(o.type).toBe("site.action_observed");
    expect(o.props).toMatchObject({ accountability: "browser_session", acct_reason: "browser_signals", action_kind: "contact", method: "POST", would_hold: false });
    expect(o.props.sig).toBeUndefined();
    expect(o.props.blocked).toBeUndefined();
  });

  it("a plain script POST is unaccountable and keeps its operator fingerprint", () => {
    const o = observeRequest({ ...base, path: "/login", method: "POST", userAgent: "python-requests/2.31", headerNames: ["user-agent", "accept"] }, DEFAULT_RULESET)!;
    // Already flagged as a hostile tool: the verdict rides on THAT event.
    expect(o.type).toBe("site.agent_flagged");
    expect(o.props).toMatchObject({ accountability: "unaccountable", acct_reason: "script_client", action_kind: "login", would_hold: true, blocked: false });
    expect(typeof o.props.fp).toBe("string");
  });

  it("an attested signed-in write is not forwarded on its own (volume), by default", () => {
    expect(observeRequest({ ...base, path: "/api/tasks", method: "POST", userAgent: CHROME, headerNames: BROWSER_HEADERS, authenticated: true }, DEFAULT_RULESET)).toBeNull();
    const rules = { ...DEFAULT_RULESET, stateChange: { ...DEFAULT_STATE_CHANGE_RULES, recordAttested: true } };
    const o = observeRequest({ ...base, path: "/api/tasks", method: "POST", userAgent: CHROME, headerNames: BROWSER_HEADERS, authenticated: true }, rules)!;
    expect(o.props).toMatchObject({ accountability: "browser_session", acct_reason: "site_attested_session" });
  });

  it("our verified synthetic probes never produce a standalone action", () => {
    expect(observeRequest({ ...base, path: "/contact", method: "POST", userAgent: CHROME, headerNames: BROWSER_HEADERS, authenticated: true, synthetic: true }, DEFAULT_RULESET)).toBeNull();
  });

  it("reads stay unchanged: a GET page view carries no verdict", () => {
    const o = observeRequest({ ...base, path: "/pricing", method: "GET", userAgent: CHROME, headerNames: BROWSER_HEADERS, accept: "text/html", secFetchDest: "document" }, DEFAULT_RULESET)!;
    expect(o.type).toBe("site.page_viewed");
    expect(o.props.accountability).toBeUndefined();
  });

  it("a block record rebuilt from an action keeps the verdict", () => {
    const inp = { ...base, path: "/contact", method: "POST", userAgent: CHROME, headerNames: BROWSER_HEADERS };
    const o = withEnforcement(observeRequest(inp, DEFAULT_RULESET), inp, DEFAULT_RULESET, { wouldBlock: true, blocked: false, reasonKind: "blocked_fingerprint" })!;
    expect(o.type).toBe("site.agent_flagged");
    expect(o.props).toMatchObject({ accountability: "browser_session", would_block: true });
  });
});

describe("server refinement with the verified principal", () => {
  const verified = (scopes: string[]) => ({ status: "verified" as const, principal: "org:acme", issuer: "acme-fleet", scopes, reason: "ok" });

  it("a verified principal inside its mandate becomes signed_principal / within", () => {
    const p: Record<string, string | number | boolean> = { accountability: "unaccountable", acct_reason: "script_client", would_hold: true };
    stampPrincipal(p, verified(["/checkout"]), "/checkout/pay");
    expect(p).toMatchObject({ accountability: "signed_principal", acct_reason: "verified_principal", mandate: "within", would_hold: false, principal: "org:acme", principal_status: "verified" });
  });

  it("a verified principal outside its mandate is held", () => {
    const p: Record<string, string | number | boolean> = { accountability: "unaccountable", acct_reason: "script_client", would_hold: true };
    stampPrincipal(p, verified(["/catalog"]), "/account/delete");
    expect(p).toMatchObject({ accountability: "signed_principal", mandate: "outside", would_hold: true });
  });

  it("a claimed principal stays unaccountable; an attested session is left alone", () => {
    const claimed = { status: "claimed" as const, scopes: [], reason: "bad sig" };
    const a: Record<string, string | number | boolean> = { accountability: "browser_session", acct_reason: "browser_signals", would_hold: false };
    stampPrincipal(a, claimed, "/x");
    expect(a).toMatchObject({ accountability: "unaccountable", acct_reason: "principal_unverified", would_hold: true });
    const b: Record<string, string | number | boolean> = { accountability: "browser_session", acct_reason: "site_attested_session", would_hold: false };
    stampPrincipal(b, claimed, "/x");
    expect(b.accountability).toBe("browser_session");
  });

  it("a body that claims signed_principal without a verified credential is downgraded", () => {
    const p: Record<string, string | number | boolean> = { accountability: "signed_principal", acct_reason: "verified_principal", mandate: "within", would_hold: false };
    stampPrincipal(p, { status: "absent", scopes: [], reason: "none" }, "/x");
    expect(p).toMatchObject({ accountability: "unaccountable", acct_reason: "principal_unverified", would_hold: true });
    expect(p.mandate).toBeUndefined();
  });

  it("applyPrincipalToAction is a no-op on a non-action event", () => {
    const p: Record<string, string | number | boolean> = { site: "x" };
    expect(applyPrincipalToAction(p, { status: "verified", withinMandate: true })).toEqual({ site: "x" });
  });
});

describe("validation of untrusted shapes", () => {
  it("coerceActionProps keeps only closed-vocabulary values", () => {
    expect(coerceActionProps({ accountability: "browser_session", acct_reason: "browser_signals", action_kind: "login", method: "POST", would_hold: false, mandate: "within" })).toEqual({
      accountability: "browser_session", acct_reason: "browser_signals", action_kind: "login", method: "POST", would_hold: false, mandate: "within",
    });
    expect(coerceActionProps({ accountability: "trusted_admin" })).toEqual({});
    expect(coerceActionProps({ accountability: "unaccountable", acct_reason: "<script>", action_kind: "a b c", method: "post", would_hold: "true" })).toEqual({ accountability: "unaccountable" });
  });

  it("the ruleset carries the rules centrally and falls back to defaults on a bad field", () => {
    const remote = { ...DEFAULT_RULESET, stateChange: { methods: ["POST"], routes: [{ pattern: "/donate", kind: "checkout" }], ignorePaths: [] } };
    expect(coerceRuleset(JSON.parse(JSON.stringify(remote)))!.stateChange!.routes).toEqual([{ pattern: "/donate", kind: "checkout" }]);
    expect(coerceRuleset({ ...DEFAULT_RULESET, stateChange: { methods: "POST" } })!.stateChange).toEqual(DEFAULT_STATE_CHANGE_RULES);
    expect(coerceStateChangeRules({ methods: ["POST"], routes: [{ pattern: "/x", kind: "BAD KIND" }], ignorePaths: [] })).toBeNull();
  });
});
