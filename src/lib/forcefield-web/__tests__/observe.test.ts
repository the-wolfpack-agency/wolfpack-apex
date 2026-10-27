import { observeRequest } from "@/lib/forcefield-web/observe";
import { DEFAULT_RULESET } from "@/lib/forcefield-web/ruleset";

const R = DEFAULT_RULESET;
const base = { site: "instinct", method: "GET", country: "US", headerNames: ["host", "user-agent"], nowMs: 1_758_000_000_000 };

describe("observeRequest - ruleset-driven, monitor-only", () => {
  it("forwards a page view for a real human navigation (Sec-Fetch-Dest: document)", () => {
    const o = observeRequest({ ...base, path: "/dashboard", userAgent: "Mozilla/5.0 (Macintosh)", headerNames: ["host", "accept", "accept-language", "accept-encoding", "user-agent"], accept: "text/html,application/xhtml+xml", secFetchDest: "document" }, R)!;
    expect(o.type).toBe("site.page_viewed");
    expect(o.path).toBe("/dashboard");
    expect(o.props.site).toBe("instinct");
    expect(typeof o.props.sig).toBe("string"); // session key, no PII
  });

  it("forwards a page view on Accept: text/html when Sec-Fetch-Dest is absent (older browsers)", () => {
    const o = observeRequest({ ...base, path: "/pricing", userAgent: "Mozilla/5.0 (Macintosh)", headerNames: ["host", "user-agent", "accept", "accept-language", "accept-encoding"], accept: "text/html,application/xhtml+xml" }, R)!;
    expect(o.type).toBe("site.page_viewed");
  });

  it("does NOT forward a page view for assets, API, XHR, or non-GET", () => {
    // Realistic browser headers so classification does not flag these as agents;
    // this isolates the page-view decision itself.
    const br = { userAgent: "Mozilla/5.0 (Macintosh)", headerNames: ["host", "user-agent", "accept", "accept-language", "accept-encoding", "sec-fetch-dest"] };
    // asset (file extension)
    expect(observeRequest({ ...base, ...br, path: "/logo.png", accept: "image/*", secFetchDest: "image" }, R)).toBeNull();
    // API call
    expect(observeRequest({ ...base, ...br, path: "/api/dashboard", accept: "application/json", secFetchDest: "empty" }, R)).toBeNull();
    // fetch/XHR (not a document)
    expect(observeRequest({ ...base, ...br, path: "/dashboard", accept: "application/json", secFetchDest: "empty" }, R)).toBeNull();
    // no document signal at all -> nothing forwarded
    expect(observeRequest({ ...base, ...br, path: "/dashboard" }, R)).toBeNull();
    // non-GET
    expect(observeRequest({ ...base, ...br, path: "/dashboard", method: "POST", secFetchDest: "document" }, R)).toBeNull();
  });

  it("an agent on an HTML page is still an agent event, never a page view", () => {
    // sqlmap requesting a document must NOT be counted as a human page view.
    const o = observeRequest({ ...base, path: "/search", userAgent: "sqlmap/1.7", accept: "text/html", secFetchDest: "document" }, R)!;
    expect(o.type).toBe("site.agent_flagged");
  });

  it("records a decoy trip (highest signal) and tags the surface", () => {
    const o = observeRequest({ ...base, path: "/_ff/records", userAgent: "x" }, R)!;
    expect(o.type).toBe("site.agent_trap_tripped");
    expect(o.props.site).toBe("instinct");
    expect(o.props.blocked).toBe(false);
    expect(o.props.posture).toBe("monitor");
    // stamps a stable operator fingerprint (fp) - header shape bound to the tool.
    expect(typeof o.props.fp).toBe("string");
    expect(o.props.fp as string).toMatch(/^[0-9a-f]+:.+$/); // "<hsig>:<tool-or-clienttype>"
  });

  it("records a sensitive-path probe and names the path", () => {
    const o = observeRequest({ ...base, path: "/wp-login.php", userAgent: "x" }, R)!;
    expect(o.type).toBe("site.agent_probed_sensitive");
    expect(o.props.probe).toBe("/wp-login.php");
  });

  it("welcomes a known crawler", () => {
    const o = observeRequest({ ...base, path: "/", userAgent: "Mozilla/5.0 (compatible; Googlebot/2.1)" }, R)!;
    expect(o.type).toBe("site.agent_welcomed");
    expect(o.props.agent).toBe("Googlebot");
  });

  it("flags a named tool and carries the tool + client_type", () => {
    const o = observeRequest({ ...base, path: "/api/x", userAgent: "python-requests/2.31" }, R)!;
    expect(o.type).toBe("site.agent_flagged");
    expect(o.props.tool).toBe("python-requests");
    expect(o.props.client_type).toBe("scripted_library");
  });

  it("flags a browser UA whose headers don't match (spoof tell)", () => {
    const o = observeRequest({ ...base, path: "/", userAgent: "Mozilla/5.0 (Windows NT 10.0)", headerNames: ["host"] }, R)!;
    expect(o.type).toBe("site.agent_flagged");
    expect(o.props.client_type).toBe("unknown");
  });

  it("sig is stable per actor+hour and includes header shape", () => {
    const a = observeRequest({ ...base, path: "/_ff/records", userAgent: "x", headerNames: ["host", "user-agent"] }, R)!;
    const b = observeRequest({ ...base, path: "/_ff/records", userAgent: "x", headerNames: ["host", "user-agent"] }, R)!;
    const c = observeRequest({ ...base, path: "/_ff/records", userAgent: "x", headerNames: ["host", "user-agent", "x-tell"] }, R)!;
    expect(a.props.sig).toBe(b.props.sig);
    expect(a.props.sig).not.toBe(c.props.sig); // header order/shape sharpens resolution
  });

  it("respects an updated ruleset (a new trap path added centrally is honored)", () => {
    const updated = { ...R, trapPaths: [...R.trapPaths, "/secret-export"] };
    expect(observeRequest({ ...base, path: "/secret-export", userAgent: "x" }, updated)?.type).toBe("site.agent_trap_tripped");
    // without the update, that path is just normal
    expect(observeRequest({ ...base, path: "/secret-export", userAgent: "Mozilla/5.0", headerNames: ["host", "accept", "accept-language", "accept-encoding"] }, R)).toBeNull();
  });

  it("does NOT flag a headless browser fetching a static asset (page sub-resource, not an agent action)", () => {
    const hc = { userAgent: "Mozilla/5.0 (X11; Linux x86_64) HeadlessChrome/120.0.0.0" };
    // /sw.js, the logo and manifest were ~75% of all flags: one headless visit
    // pulls a dozen assets, and each was becoming its own "flagged agent".
    expect(observeRequest({ ...base, ...hc, path: "/sw.js" }, R)).toBeNull();
    expect(observeRequest({ ...base, ...hc, path: "/wolfpack-logo.png" }, R)).toBeNull();
    expect(observeRequest({ ...base, ...hc, path: "/manifest.json" }, R)).toBeNull();
    expect(observeRequest({ ...base, ...hc, path: "/_next/static/chunk.js" }, R)).toBeNull();
  });

  it("STILL flags a headless browser on a real page/endpoint (the agent itself)", () => {
    const hc = { userAgent: "Mozilla/5.0 (X11; Linux x86_64) HeadlessChrome/120.0.0.0" };
    expect(observeRequest({ ...base, ...hc, path: "/admin" }, R)!.type).toBe("site.agent_flagged");
    expect(observeRequest({ ...base, ...hc, path: "/assistant" }, R)!.type).toBe("site.agent_flagged");
  });

  it("a NAMED hostile tool is still flagged on ANY path, including an asset", () => {
    // sqlmap/python-requests are proven tradecraft, not page sub-resources.
    expect(observeRequest({ ...base, path: "/app.js", userAgent: "sqlmap/1.7" }, R)!.type).toBe("site.agent_flagged");
    expect(observeRequest({ ...base, path: "/api/x", userAgent: "python-requests/2.31" }, R)!.type).toBe("site.agent_flagged");
  });

});

import { withEnforcement, clientKeys } from "@/lib/forcefield-web/observe";
import { parseCidr } from "@/lib/forcefield-web/hosting";

// A real Chrome top-level navigation: the header set Chrome 131 actually sends.
const CHROME_HEADERS = ["host", "connection", "sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform", "upgrade-insecure-requests", "user-agent", "accept", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-user", "sec-fetch-dest", "accept-encoding", "accept-language", "cookie"];
const CHROME_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const chrome = { ...base, userAgent: CHROME_UA, headerNames: CHROME_HEADERS, accept: "text/html,application/xhtml+xml", secFetchDest: "document" };

describe("no regression for real browser traffic", () => {
  it("a normal Chrome page view produces ONLY site.page_viewed (with any query string)", () => {
    for (const rawUrl of ["/", "/pricing", "/pricing?utm_source=newsletter&utm_medium=email", "/search?q=next.js+image+optimization"]) {
      const path = rawUrl.split("?")[0];
      const o = observeRequest({ ...chrome, path, rawUrl, ip: "24.60.1.1" }, R)!;
      expect(o.type).toBe("site.page_viewed");
      expect(Object.keys(o.props).sort()).toEqual(["sig", "site"]);
    }
  });
  it("Chrome XHR to the app's own API and remote next/image assets forward nothing", () => {
    const xhr = { ...chrome, accept: "application/json", secFetchDest: "empty" };
    expect(observeRequest({ ...xhr, path: "/api/dashboard", rawUrl: "/api/dashboard?range=7d" }, R)).toBeNull();
    expect(observeRequest({ ...chrome, secFetchDest: "image", accept: "image/avif", path: "/_next/image", rawUrl: "/_next/image?url=https%3A%2F%2Fcdn.example.com%2Fa.png&w=640&q=75" }, R)).toBeNull();
  });
});

describe("payload records (site.agent_payload_attack)", () => {
  it("a payload in the query is recorded with props.attack, ranked right after a trap", () => {
    const o = observeRequest({ ...chrome, path: "/search", rawUrl: "/search?q=1%20UNION%20SELECT%20pw%20FROM%20users" }, R)!;
    expect(o.type).toBe("site.agent_payload_attack");
    expect(o.props.attack).toBe("sql_injection");
    expect(o.props.blocked).toBe(false);
    // outranks a sensitive probe on the same request
    expect(observeRequest({ ...base, path: "/wp-login.php", rawUrl: "/wp-login.php?x=<script>alert(1)</script>", userAgent: "x" }, R)!.type).toBe("site.agent_payload_attack");
    // a trap still wins
    expect(observeRequest({ ...base, path: "/_ff/records", rawUrl: "/_ff/records?q=<script>", userAgent: "x" }, R)!.type).toBe("site.agent_trap_tripped");
  });
  it("falls back to path when rawUrl is absent", () => {
    expect(observeRequest({ ...base, path: "/x/../../etc/passwd", userAgent: "x" }, R)!.props.attack).toBe("path_traversal");
  });
  it("x-middleware-subrequest from a client is a payload attack even from a browser UA", () => {
    const o = observeRequest({ ...chrome, path: "/admin", headerNames: [...CHROME_HEADERS, "x-middleware-subrequest"] }, R)!;
    expect(o.type).toBe("site.agent_payload_attack");
    expect(o.props.attack).toBe("nextjs_middleware_bypass");
  });
  it("x-middleware-subrequest on a control-plane endpoint is not recorded as an attack", () => {
    const sub = [...base.headerNames, "x-middleware-subrequest"];
    const o = observeRequest({ ...base, path: "/api/site-analytics/ingest", userAgent: "x", headerNames: sub }, R);
    expect(o?.props.attack).toBeUndefined();
    // Same request off the control plane is still the attack (the test is not vacuous).
    expect(observeRequest({ ...base, path: "/admin", userAgent: "x", headerNames: sub }, R)!.props.attack).toBe("nextjs_middleware_bypass");
  });
  it("PHP-CGI injection is recorded as php_cgi_injection", () => {
    expect(observeRequest({ ...base, path: "/index.php", rawUrl: "/index.php?%ADd+allow_url_include%3d1+-d+auto_prepend_file%3dphp://input", userAgent: "x" }, R)!.props.attack).toBe("php_cgi_injection");
  });
  it("a body-proven attack (bodyAttack) is recorded as a payload attack with its CWE", () => {
    const o = observeRequest({ ...base, method: "POST", path: "/upload.php", userAgent: "x", bodyAttack: "php2shell" }, R)!;
    expect(o.type).toBe("site.agent_payload_attack");
    expect(o.props.attack).toBe("php2shell");
    expect(o.props.cwe).toBe("CWE-787");
    expect(o.props.blocked).toBe(false); // observe is monitor-only
  });
});

describe("secret-file variants (dotfile rule + data)", () => {
  const probe = (path: string) => observeRequest({ ...base, path, userAgent: "x" }, R)?.props.probe;
  it("matches .env variants seen in production and generic suffixes", () => {
    for (const p of ["/.env", "/.env.production", "/.env.backup", "/.env.swp", "/.env.staging", "/.env~", "/.env.local.bak"]) expect(probe(p)).toBeTruthy();
  });
  it("does NOT match look-alike names", () => {
    // A dotted last segment reads as a file extension, so these are not page
    // views either; the point is they are never a sensitive probe.
    for (const p of ["/.environment", "/.envoy", "/environment", "/.envelope/x"]) {
      const o = observeRequest({ ...base, path: p, userAgent: "curl/8.5.0" }, R)!;
      expect(o.type).toBe("site.agent_flagged"); // an event exists (curl), but not a probe
      expect(o.props.probe).toBeUndefined();
    }
  });
  it("matches .git/HEAD and wp-config backups", () => {
    expect(probe("/.git/HEAD")).toBeTruthy();
    expect(probe("/wp-config.php.bak")).toBeTruthy();
    expect(probe("/wp-config.php~")).toBe("/wp-config.php~");
  });
});

describe("LLMjacking / AI-endpoint recon", () => {
  const probe = (path: string, method = "GET") => observeRequest({ ...base, path, method, userAgent: "x" }, R);
  it.each(["/v1/models", "/v1/chat/completions", "/v1/messages", "/api/tags", "/api/generate", "/api/ps", "/mcp", "/sse", "/.claude/.credentials.json", "/.cursor/mcp.json", "/.vscode/mcp.json", "/object_info", "/customnode/install/pip"])(
    "%s is a sensitive probe",
    (p) => {
      const o = probe(p, p === "/mcp" ? "POST" : "GET")!;
      expect(o.type).toBe("site.agent_probed_sensitive");
    },
  );
  it("Instinct's real /api/version route is NOT a probe", () => {
    expect(observeRequest({ ...chrome, path: "/api/version", accept: "application/json", secFetchDest: "empty" }, R)).toBeNull();
  });
});

describe("platform awareness (ruleset.platformPaths)", () => {
  it("WordPress-native paths are recon on a non-WP site but not on a site that declares wordpress", () => {
    for (const p of ["/wp-login.php", "/wp-admin/admin-ajax.php", "/xmlrpc.php", "/wp-content/plugins/updraftplus/readme.txt", "/wp-json/wp/v2/posts"]) {
      expect(observeRequest({ ...base, path: p, userAgent: "x" }, R)!.type).toBe("site.agent_probed_sensitive");
      const wp = observeRequest({ ...chrome, path: p, platform: "wordpress" }, R);
      expect(wp?.type ?? "none").not.toBe("site.agent_probed_sensitive");
    }
  });
  it("on a WP site, .env and wp-config backups are STILL probes", () => {
    expect(observeRequest({ ...base, path: "/.env", userAgent: "x", platform: "wordpress" }, R)!.type).toBe("site.agent_probed_sensitive");
    expect(observeRequest({ ...base, path: "/wp-config.php.bak", userAgent: "x", platform: "wordpress" }, R)!.type).toBe("site.agent_probed_sensitive");
  });
  it("names the targeted plugin on a non-WP site", () => {
    expect(observeRequest({ ...base, path: "/wp-content/plugins/seo-by-rank-math-pro/readme.txt", userAgent: "x" }, R)!.props.probe).toBe("/wp-content/plugins/seo-by-rank-math-pro");
  });
  it("UpdraftCentral: a forged client UA on WP, any command on non-WP; the genuine client is quiet on WP", () => {
    const forged = "WordPress/6.8.5; class-udrpc.php";
    const genuine = "WordPress/6.8.5; class-udrpc.php/2.0; https://teamupdraft.com";
    expect(observeRequest({ ...base, path: "/", method: "POST", userAgent: forged, platform: "wordpress" }, R)!.props.probe).toBe("updraftcentral_forged_client");
    expect(observeRequest({ ...base, path: "/", method: "POST", userAgent: genuine }, R)!.props.probe).toBe("updraftcentral_command");
    expect(observeRequest({ ...base, path: "/", method: "POST", userAgent: genuine, platform: "wordpress" }, R)?.props.probe).toBeUndefined();
  });
  it("UpdraftCentral: mentioning teamupdraft.com anywhere is not enough; the dashboard HOST must be it", () => {
    for (const spoof of [
      "WordPress/6.8.5; class-udrpc.php/2.0; https://evil.example/?teamupdraft.com",
      "WordPress/6.8.5; class-udrpc.php/2.0; https://teamupdraft.com.evil.example",
      "teamupdraft.com WordPress/6.8.5; class-udrpc.php",
    ]) {
      expect(observeRequest({ ...base, path: "/", method: "POST", userAgent: spoof, platform: "wordpress" }, R)!.props.probe).toBe("updraftcentral_forged_client");
    }
    expect(observeRequest({ ...base, path: "/", method: "POST", userAgent: "WordPress/6.8.5; class-udrpc.php/2.0.1; https://app.teamupdraft.com/dash", platform: "wordpress" }, R)?.props.probe).toBeUndefined();
  });
  it("UpdraftCentral backdoor trigger shape is reported on WP only", () => {
    const rawUrl = "/?_ab12cd=" + "a".repeat(32);
    expect(observeRequest({ ...chrome, path: "/", rawUrl, platform: "wordpress" }, R)!.props.probe).toBe("wp_backdoor_trigger");
    expect(observeRequest({ ...chrome, path: "/", rawUrl }, R)!.type).toBe("site.page_viewed");
  });
});

describe("Next.js server-action probe", () => {
  it("next-action from a non-browser client is a report-only probe; from a real browser it is nothing", () => {
    const o = observeRequest({ ...base, path: "/login", method: "POST", userAgent: "python-requests/2.31", headerNames: ["host", "user-agent", "next-action"] }, R)!;
    expect(o.type).toBe("site.agent_probed_sensitive");
    expect(o.props.probe).toBe("next_server_action");
    expect(o.props.blocked).toBe(false);
    expect(observeRequest({ ...chrome, path: "/login", method: "POST", secFetchDest: "empty", headerNames: [...CHROME_HEADERS, "next-action"] }, R)).toBeNull();
  });
});

describe("authenticated (site-attested) noise suppression", () => {
  const hc = "Mozilla/5.0 (X11; Linux x86_64) HeadlessChrome/131.0.0.0 Safari/537.36";
  it("suppresses headless / scripted-library / header-mismatch tells", () => {
    expect(observeRequest({ ...base, path: "/api/ms/chats/unread-count", userAgent: hc, authenticated: true }, R)).toBeNull();
    expect(observeRequest({ ...base, path: "/api/automations/porsche-classes/poll", method: "POST", userAgent: "curl/8.5.0", authenticated: true }, R)).toBeNull();
    expect(observeRequest({ ...base, path: "/api/x", userAgent: "Mozilla/5.0", headerNames: ["host"], authenticated: true }, R)).toBeNull();
    // same requests anonymous are flagged
    expect(observeRequest({ ...base, path: "/api/ms/chats/unread-count", userAgent: hc }, R)!.type).toBe("site.agent_flagged");
    expect(observeRequest({ ...base, path: "/api/automations/porsche-classes/poll", method: "POST", userAgent: "curl/8.5.0" }, R)!.type).toBe("site.agent_flagged");
  });
  it("still fires named scanners, traps, sensitive probes and payloads", () => {
    expect(observeRequest({ ...base, path: "/", userAgent: "sqlmap/1.7", authenticated: true }, R)!.type).toBe("site.agent_flagged");
    expect(observeRequest({ ...base, path: "/_ff/records", userAgent: hc, authenticated: true }, R)!.type).toBe("site.agent_trap_tripped");
    expect(observeRequest({ ...base, path: "/.env", userAgent: hc, authenticated: true }, R)!.type).toBe("site.agent_probed_sensitive");
    const p = observeRequest({ ...base, path: "/q", rawUrl: "/q?x=<script>", userAgent: hc, authenticated: true }, R)!;
    expect(p.type).toBe("site.agent_payload_attack");
    expect(p.props.authenticated).toBe(true);
  });
});

describe("AI agents + verified crawler identity", () => {
  const compact = (c: string) => { const p = parseCidr(c)!; return `${p.base >>> 0}/${p.bits}`; };
  const RR = { ...R, verifiedAgentRanges: { Googlebot: [compact("66.249.64.0/19")] } };
  const gb = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
  it("verified when the IP is inside the vendor's ranges", () => {
    const o = observeRequest({ ...base, path: "/", userAgent: gb, ip: "66.249.66.1" }, RR)!;
    expect(o.type).toBe("site.agent_welcomed");
    expect(o.props.agent_verification).toBe("verified");
  });
  it("impersonation when outside: flagged with props.impersonating", () => {
    const o = observeRequest({ ...base, path: "/", userAgent: gb, ip: "203.0.113.9" }, RR)!;
    expect(o.type).toBe("site.agent_flagged");
    expect(o.props.impersonating).toBe("Googlebot");
    expect(o.props.agent_verification).toBe("impersonation");
  });
  it("unverifiable when no ranges / no IPv4: still welcomed", () => {
    const o = observeRequest({ ...base, path: "/", userAgent: gb }, RR)!;
    expect(o.type).toBe("site.agent_welcomed");
    expect(o.props.agent_verification).toBe("unverifiable");
  });
  it.each([
    ["Claude-User", "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-User/1.0; +Claude-User@anthropic.com)"],
    ["Claude-SearchBot", "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-SearchBot/1.0; +https://www.anthropic.com/claudesearchbot)"],
    ["Perplexity-User", "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Perplexity-User/1.0; +https://perplexity.ai/perplexity-user)"],
    ["MistralAI-User", "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; MistralAI-User/1.0; +https://docs.mistral.ai/robots)"],
    ["DuckAssistBot", "DuckAssistBot/1.2; (+http://duckduckgo.com/duckassistbot.html)"],
    ["Meta-ExternalAgent", "meta-externalagent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)"],
    ["Google-CloudVertexBot", "Mozilla/5.0 (compatible; Google-CloudVertexBot)"],
  ])("documented agent %s is welcomed", (id, ua) => {
    const o = observeRequest({ ...base, path: "/", userAgent: ua }, R)!;
    expect(o.type).toBe("site.agent_welcomed");
    expect(o.props.agent).toBe(id);
  });
  it("Web Bot Auth signed agent (ChatGPT agent) records signed_agent=true", () => {
    const o = observeRequest({ ...chrome, path: "/", headerNames: [...CHROME_HEADERS, "signature-agent", "signature", "signature-input"] }, R)!;
    expect(o.type).toBe("site.agent_welcomed");
    expect(o.props.signed_agent).toBe(true);
    expect(o.props.agent).toBe("signed_agent");
    // partial header set is not a signed agent
    expect(observeRequest({ ...chrome, path: "/", headerNames: [...CHROME_HEADERS, "signature"] }, R)!.type).toBe("site.page_viewed");
  });
});

describe("withEnforcement - the stored row says what happened", () => {
  const input = { ...base, path: "/x", rawUrl: "/x?q=<script>", userAgent: "x" };
  const obs = observeRequest(input, R);
  it("blocked: blocked/action/posture/reason_kind", () => {
    const o = withEnforcement(obs, input, R, { wouldBlock: true, blocked: true, reasonKind: "payload", attack: "xss" })!;
    expect(o.props).toMatchObject({ blocked: true, action: "block", posture: "enforce", reason_kind: "payload", attack: "xss" });
  });
  it("withheld by a gate: would_block + action report, never blocked", () => {
    const o = withEnforcement(obs, input, R, { wouldBlock: true, blocked: false, reasonKind: "payload" })!;
    expect(o.props).toMatchObject({ blocked: false, would_block: true, action: "report", posture: "monitor" });
  });
  it("a block with no observation (or only a page view) still produces an agent record", () => {
    const pv = observeRequest({ ...chrome, path: "/" }, R);
    expect(pv!.type).toBe("site.page_viewed");
    const o = withEnforcement(pv, { ...chrome, path: "/" }, R, { wouldBlock: true, blocked: true, reasonKind: "blocked_fingerprint" })!;
    expect(o.type).toBe("site.agent_flagged");
    expect(o.props).toMatchObject({ blocked: true, reason_kind: "blocked_fingerprint" });
    expect(typeof o.props.fp).toBe("string");
    expect(withEnforcement(null, { ...chrome, path: "/" }, R, { wouldBlock: true, blocked: true })!.type).toBe("site.agent_flagged");
  });
  it("no-op when nothing would be blocked", () => {
    expect(withEnforcement(obs, input, R, { wouldBlock: false, blocked: false })).toBe(obs);
    expect(withEnforcement(null, input, R, { wouldBlock: false, blocked: false })).toBeNull();
  });
  it("clientKeys matches the fp observeRequest stamps", () => {
    expect(clientKeys(input, R).fp).toBe(obs!.props.fp);
  });
});

describe("synthetic attestation stamp", () => {
  const hc = "Mozilla/5.0 HeadlessChrome/131.0.0.0";
  it("a synthetic request's hostile event carries synthetic + authenticated, after the attack class", () => {
    const o = observeRequest({ ...base, path: "/q", rawUrl: "/q?x=<script>", userAgent: hc, authenticated: true, synthetic: true }, R)!;
    expect(o.type).toBe("site.agent_payload_attack");
    expect(o.props.synthetic).toBe(true);
    expect(o.props.authenticated).toBe(true);
    const keys = Object.keys(o.props);
    expect(keys.indexOf("synthetic")).toBeGreaterThan(keys.indexOf("attack"));
  });
  it("authenticated alone (a signed-in user) is NOT synthetic", () => {
    const o = observeRequest({ ...base, path: "/_ff/records", userAgent: hc, authenticated: true }, R)!;
    expect(o.props.authenticated).toBe(true);
    expect(o.props.synthetic).toBeUndefined();
  });
  it("the block-record path (no base observation) still stamps synthetic", () => {
    const input = { ...base, path: "/plain", userAgent: "Mozilla/5.0 (Macintosh) Chrome/131", authenticated: true, synthetic: true };
    const o = withEnforcement(null, input, R, { wouldBlock: true, blocked: true, reasonKind: "blocked_fingerprint" })!;
    expect(o.props.synthetic).toBe(true);
    expect(o.props.authenticated).toBe(true);
  });
  it("an anonymous request is never stamped, whatever its UA claims", () => {
    const o = observeRequest({ ...base, path: "/_ff/records", userAgent: "wolfpack-verify/1.0" }, R)!;
    expect(o.props.synthetic).toBeUndefined();
    expect(o.props.authenticated).toBeUndefined();
  });
});
