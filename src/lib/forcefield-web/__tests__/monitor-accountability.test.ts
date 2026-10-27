/** @jest-environment node */
/**
 * The vendored monitor forwards an action's verdict and, for a state-changing
 * request ONLY, the agent's delegation credential, so the ingest can verify the
 * principal. A read never forwards the credential. Watch mode: the monitor
 * never touches the response.
 */
import { forcefieldMonitor, delegationFor, DELEGATION_HEADER } from "@/lib/forcefield-web/monitor";
import { _resetRulesetCache } from "@/lib/forcefield-web/ruleset";

const ORIG = { ...process.env };
beforeEach(() => {
  _resetRulesetCache();
  process.env.FORCEFIELD_WEB = "on";
  process.env.SITE_ANALYTICS_INGEST_TOKEN = "secret";
  process.env.FORCEFIELD_INGEST_URL = "https://hub.example/api/site-analytics/ingest";
  delete process.env.FORCEFIELD_RULESET_URL;
  delete process.env.FORCEFIELD_ENFORCE;
});
afterEach(() => {
  for (const k of ["FORCEFIELD_WEB", "SITE_ANALYTICS_INGEST_TOKEN", "FORCEFIELD_INGEST_URL", "FORCEFIELD_RULESET_URL", "FORCEFIELD_ENFORCE"]) {
    if (ORIG[k] === undefined) delete process.env[k]; else process.env[k] = ORIG[k];
  }
  jest.restoreAllMocks();
});

const mk = (method: string, path: string, headers: Record<string, string>) => ({ method, nextUrl: { pathname: path }, headers: new Headers(headers) });

it("forwards an agent's delegation with its action", async () => {
  const f = jest.spyOn(global, "fetch").mockResolvedValue(new Response(null));
  await forcefieldMonitor({ site: "shop", req: mk("POST", "/checkout", { "user-agent": "acme-agent/1.0", [DELEGATION_HEADER]: "b64.123.sig" }) });
  const body = JSON.parse(String((f.mock.calls[0][1] as RequestInit).body));
  expect(body.type).toBe("site.action_observed");
  expect(body.delegation).toBe("b64.123.sig");
  expect(body.props).toMatchObject({ accountability: "unaccountable", action_kind: "checkout", method: "POST", would_hold: true });
});

it("never forwards the credential with a read", async () => {
  const f = jest.spyOn(global, "fetch").mockResolvedValue(new Response(null));
  await forcefieldMonitor({ site: "shop", req: mk("GET", "/catalog", { "user-agent": "python-requests/2.31", [DELEGATION_HEADER]: "b64.123.sig" }) });
  const body = JSON.parse(String((f.mock.calls[0][1] as RequestInit).body));
  expect(body.delegation).toBeUndefined();
  expect(body.props.accountability).toBeUndefined();
});

it("drops an oversized credential", () => {
  const obs = { type: "site.action_observed" as const, path: "/x", props: { accountability: "unaccountable" } };
  expect(delegationFor(new Headers({ [DELEGATION_HEADER]: "a".repeat(9000) }), obs)).toBeUndefined();
  expect(delegationFor(new Headers({ [DELEGATION_HEADER]: "abc" }), obs)).toBe("abc");
  expect(delegationFor(new Headers({ [DELEGATION_HEADER]: "abc" }), null)).toBeUndefined();
});
