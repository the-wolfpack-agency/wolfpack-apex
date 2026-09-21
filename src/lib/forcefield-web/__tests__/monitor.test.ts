/** @jest-environment node */
import { forcefieldMonitor, forcefieldGuard } from "@/lib/forcefield-web/monitor";
import { _resetRulesetCache } from "@/lib/forcefield-web/ruleset";

const req = (path: string, ua = "Mozilla/5.0") => ({
  method: "GET",
  nextUrl: { pathname: path },
  headers: new Headers({ "user-agent": ua, "x-vercel-ip-country": "US" }),
});

const ORIG = { ...process.env };
beforeEach(() => { _resetRulesetCache(); });
afterEach(() => {
  for (const k of ["FORCEFIELD_WEB", "FORCEFIELD_ENFORCE", "SITE_ANALYTICS_INGEST_TOKEN", "FORCEFIELD_INGEST_URL", "FORCEFIELD_RULESET_URL"]) {
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
    await forcefieldMonitor({ site: "instinct", req: req("/", "python-requests/2") });
    expect(f).not.toHaveBeenCalled();
  });

  it("no forward without a token or a configured ingest URL (SSRF-safe)", async () => {
    process.env.FORCEFIELD_WEB = "on";
    delete process.env.SITE_ANALYTICS_INGEST_TOKEN;
    process.env.FORCEFIELD_INGEST_URL = "https://hub.example/ingest";
    const f = jest.spyOn(global, "fetch").mockResolvedValue(new Response(null));
    await forcefieldMonitor({ site: "instinct", req: req("/", "curl/8") });
    process.env.SITE_ANALYTICS_INGEST_TOKEN = "secret";
    delete process.env.FORCEFIELD_INGEST_URL;
    await forcefieldMonitor({ site: "instinct", req: req("/", "curl/8") });
    expect(f).not.toHaveBeenCalled();
  });

  it("when enabled: forwards a flagged tool to the CONFIGURED ingest, surface-tagged", async () => {
    enable();
    const f = jest.spyOn(global, "fetch").mockResolvedValue(new Response(null));
    await forcefieldMonitor({ site: "aidanmulready", req: req("/api/x", "sqlmap/1.7") });
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0];
    expect(String(url)).toBe("https://hub.example/api/site-analytics/ingest");
    expect((init as RequestInit).headers).toMatchObject({ "x-ingest-token": "secret" });
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body.type).toBe("site.agent_flagged");
    expect(body.props).toMatchObject({ site: "aidanmulready", tool: "sqlmap", client_type: "scanner", blocked: false });
  });

  it("a normal visitor forwards nothing", async () => {
    enable();
    const f = jest.spyOn(global, "fetch").mockResolvedValue(new Response(null));
    const r = { method: "GET", nextUrl: { pathname: "/pricing" }, headers: new Headers({ "user-agent": "Mozilla/5.0", accept: "*", "accept-language": "en", "accept-encoding": "gzip" }) };
    await forcefieldMonitor({ site: "instinct", req: r });
    expect(f).not.toHaveBeenCalled();
  });

  it("is FAIL-OPEN: never throws even if the forward blows up", async () => {
    enable();
    jest.spyOn(global, "fetch").mockImplementation(() => { throw new Error("edge fetch died"); });
    await expect(forcefieldMonitor({ site: "instinct", req: req("/", "nuclei/3") })).resolves.toBeUndefined();
  });
});


describe("forcefieldGuard - the enforcement block decision", () => {
  const greq = (path: string, ua = "Mozilla/5.0", search = "") => ({
    method: "GET",
    nextUrl: { pathname: path, search },
    headers: new Headers({ "user-agent": ua, accept: "text/html", "accept-language": "en", "accept-encoding": "gzip" }),
  });

  it("returns null when enforcement is OFF, even for a hostile request", async () => {
    process.env.FORCEFIELD_WEB = "on";
    delete process.env.FORCEFIELD_ENFORCE;
    delete process.env.FORCEFIELD_RULESET_URL;
    expect(await forcefieldGuard({ site: "instinct", req: greq("/_ff/records", "sqlmap/1.7") })).toBeNull();
  });

  it("returns a block decision for a decoy trip when enforcement is ON", async () => {
    process.env.FORCEFIELD_WEB = "on";
    process.env.FORCEFIELD_ENFORCE = "on";
    delete process.env.FORCEFIELD_RULESET_URL;
    const d = await forcefieldGuard({ site: "instinct", req: greq("/_ff/records", "x") });
    expect(d?.block).toBe(true);
    expect(d?.reasonKind).toBe("decoy");
  });

  it("blocks a named attack tool and a payload when ON", async () => {
    process.env.FORCEFIELD_WEB = "on";
    process.env.FORCEFIELD_ENFORCE = "on";
    delete process.env.FORCEFIELD_RULESET_URL;
    expect((await forcefieldGuard({ site: "instinct", req: greq("/x", "sqlmap/1.7") }))?.reasonKind).toBe("attack_tool");
    expect((await forcefieldGuard({ site: "instinct", req: greq("/search", "Mozilla/5.0", "?q=<script>alert(1)</script>") }))?.reasonKind).toBe("payload");
  });

  it("returns null (allows) a normal human request even when enforcement is ON", async () => {
    process.env.FORCEFIELD_WEB = "on";
    process.env.FORCEFIELD_ENFORCE = "on";
    delete process.env.FORCEFIELD_RULESET_URL;
    expect(await forcefieldGuard({ site: "instinct", req: greq("/pricing") })).toBeNull();
  });
});
