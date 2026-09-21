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
});
