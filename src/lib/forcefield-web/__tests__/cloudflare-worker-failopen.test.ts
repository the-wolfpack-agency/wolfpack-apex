/**
 * @jest-environment node
 *
 * The two catastrophic Forcefield failures, locked as a guard:
 *   1. FAIL-OPEN: any engine error (ruleset fetch down, evaluate throws) must still
 *      let the request reach the origin. Forcefield never takes the site down.
 *   2. WATCH-FIRST: a block verdict is enforced ONLY when FORCEFIELD_ENFORCE==="on".
 *      With enforce off, even a proven-hostile request is forwarded (reported, not
 *      blocked), so turning Forcefield on can never surprise-block real traffic.
 *
 * Drives the real Worker entrypoint with fetch mocked for the ruleset + origin.
 */
import { forcefieldWorker } from "../adapters/cloudflare-worker";
import { DEFAULT_RULESET } from "../ruleset";

const ORIGIN_BODY = "ORIGIN_SERVED";
const ctx = { waitUntil: () => {} } as unknown as Parameters<typeof forcefieldWorker.fetch>[2];

function env(enforce: string) {
  return {
    FORCEFIELD_ORIGIN: "https://origin.example",
    FORCEFIELD_RULESET_URL: "https://cp.example/ruleset",
    FORCEFIELD_SITE: "acme",
    FORCEFIELD_INGEST_URL: "https://cp.example/ingest",
    SITE_ANALYTICS_INGEST_TOKEN: "ff_x",
    FORCEFIELD_ENFORCE: enforce,
  } as unknown as Parameters<typeof forcefieldWorker.fetch>[1];
}

function mockFetch(opts: { rulesetThrows?: boolean } = {}) {
  global.fetch = jest.fn(async (input: unknown) => {
    const url = typeof input === "string" ? input : String((input as Request).url ?? input);
    if (url.includes("/ruleset")) {
      if (opts.rulesetThrows) throw new Error("ruleset unreachable");
      return { ok: true, json: async () => DEFAULT_RULESET } as unknown as Response;
    }
    if (url.includes("/ingest")) return { ok: true, json: async () => ({}) } as unknown as Response;
    return new Response(ORIGIN_BODY, { status: 200 }); // origin proxy
  }) as unknown as typeof fetch;
}

// A proven-hostile request: the default ruleset's trap path. decideEnforcement blocks it.
const trapReq = () => new Request("https://acme.example/_ff/records", { method: "GET" });
const benignReq = () => new Request("https://acme.example/", { method: "GET" });

beforeEach(() => jest.restoreAllMocks());

it("WATCH-FIRST: a hostile request is NOT blocked when enforce is off", async () => {
  mockFetch();
  const res = await forcefieldWorker.fetch(trapReq(), env("off"), ctx);
  expect(res.status).toBe(200);
  expect(await res.text()).toBe(ORIGIN_BODY); // forwarded to origin, not 403
});

it("ENFORCE: the same hostile request IS blocked when enforce is on", async () => {
  mockFetch();
  const res = await forcefieldWorker.fetch(trapReq(), env("on"), ctx);
  expect(res.status).toBe(403);
  expect(res.headers.get("x-forcefield")).toMatch(/blocked:/);
});

it("FAIL-SAFE: a ruleset outage never breaks the site (benign request still served)", async () => {
  // fetchRuleset self-defaults on any error, so a ruleset outage cannot throw or
  // black-hole a request; combined with the entrypoint's outer try/catch that
  // proxies on any unexpected error, Forcefield never takes the site down.
  mockFetch({ rulesetThrows: true });
  const res = await forcefieldWorker.fetch(benignReq(), env("on"), ctx);
  expect(res.status).toBe(200);
  expect(await res.text()).toBe(ORIGIN_BODY);
});

it("a benign request is forwarded even with enforce on", async () => {
  mockFetch();
  const res = await forcefieldWorker.fetch(benignReq(), env("on"), ctx);
  expect(res.status).toBe(200);
  expect(await res.text()).toBe(ORIGIN_BODY);
});
