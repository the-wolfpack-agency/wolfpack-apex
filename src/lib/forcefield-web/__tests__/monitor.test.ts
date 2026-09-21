/** @jest-environment node */
import { forcefieldMonitor } from "@/lib/forcefield-web/monitor";
import { _resetRulesetCache } from "@/lib/forcefield-web/ruleset";

const req = (path: string, ua = "Mozilla/5.0") => ({
  method: "GET",
  nextUrl: { pathname: path },
  headers: new Headers({ "user-agent": ua, "x-vercel-ip-country": "US" }),
});

const ORIG = { ...process.env };
beforeEach(() => { _resetRulesetCache(); });
afterEach(() => {
  for (const k of ["FORCEFIELD_WEB", "SITE_ANALYTICS_INGEST_TOKEN", "FORCEFIELD_INGEST_URL", "FORCEFIELD_RULESET_URL"]) {
    if (ORIG[k] === undefined) delete process.env[k]; else process.env[k] = ORIG[k];
  }
  jest.restoreAllMocks();
});
function enable() {
  process.env.FORCEFIELD_WEB = "on";
  process.env.SITE_ANALYTICS_INGEST_TOKEN = "secret";
  process.env.FORCEFIELD_INGEST_URL = "https://hub.example/api/site-analytics/ingest";
  delete process.env.FORCEFIELD_RULESET_URL; // -> bundled defaults, no ruleset fetch
}

describe("forcefieldMonitor - the drop-in shim", () => {
  it("is DARK by default: no forward when FORCEFIELD_WEB is unset", async () => {
    delete process.env.FORCEFIELD_WEB;
    const f = jest.spyOn(global, "fetch").mockResolvedValue(new Response(null));
    await forcefieldMonitor({ surface: "instinct", req: req("/", "python-requests/2") });
    expect(f).not.toHaveBeenCalled();
  });

  it("no forward without a token or a configured ingest URL (SSRF-safe)", async () => {
    process.env.FORCEFIELD_WEB = "on";
    delete process.env.SITE_ANALYTICS_INGEST_TOKEN;
    process.env.FORCEFIELD_INGEST_URL = "https://hub.example/ingest";
    const f = jest.spyOn(global, "fetch").mockResolvedValue(new Response(null));
    await forcefieldMonitor({ surface: "instinct", req: req("/", "curl/8") });
    process.env.SITE_ANALYTICS_INGEST_TOKEN = "secret";
    delete process.env.FORCEFIELD_INGEST_URL;
    await forcefieldMonitor({ surface: "instinct", req: req("/", "curl/8") });
    expect(f).not.toHaveBeenCalled();
  });

  it("when enabled: forwards a flagged tool to the CONFIGURED ingest, surface-tagged", async () => {
    enable();
    const f = jest.spyOn(global, "fetch").mockResolvedValue(new Response(null));
    await forcefieldMonitor({ surface: "aidanmulready", req: req("/api/x", "sqlmap/1.7") });
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0];
    expect(String(url)).toBe("https://hub.example/api/site-analytics/ingest");
    expect((init as RequestInit).headers).toMatchObject({ "x-ingest-token": "secret" });
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body.type).toBe("site.agent_flagged");
    expect(body.props).toMatchObject({ surface: "aidanmulready", tool: "sqlmap", client_type: "scanner", blocked: false });
  });

  it("a normal visitor forwards nothing", async () => {
    enable();
    const f = jest.spyOn(global, "fetch").mockResolvedValue(new Response(null));
    const r = { method: "GET", nextUrl: { pathname: "/pricing" }, headers: new Headers({ "user-agent": "Mozilla/5.0", accept: "*", "accept-language": "en", "accept-encoding": "gzip" }) };
    await forcefieldMonitor({ surface: "instinct", req: r });
    expect(f).not.toHaveBeenCalled();
  });

  it("is FAIL-OPEN: never throws even if the forward blows up", async () => {
    enable();
    jest.spyOn(global, "fetch").mockImplementation(() => { throw new Error("edge fetch died"); });
    await expect(forcefieldMonitor({ surface: "instinct", req: req("/", "nuclei/3") })).resolves.toBeUndefined();
  });
});
