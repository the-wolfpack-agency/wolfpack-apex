/** @jest-environment node */
/**
 * Forcefield Cloudflare Worker adapter - the pure decision core.
 *
 * The adapter must detect exactly what the Next middleware detects, because both
 * call the same engine; these tests pin that the Worker's request-mapping feeds
 * the engine correctly, against the REAL bundled ruleset (no mocks of the engine).
 */
import { requestSignals, evaluateRequest, shouldBlock, workerAuthenticated, inspectBodyBounded } from "../cloudflare-worker";
import { DEFAULT_RULESET } from "../../ruleset";

const AT = 1_700_000_000_000; // fixed nowMs for determinism

function req(url: string, headers: Record<string, string> = {}): Request {
  return new Request(url, { headers });
}

describe("requestSignals", () => {
  it("lowercases header names and pulls UA / country / client IP from edge headers", () => {
    const s = requestSignals(
      req("https://site.example/path?q=1", {
        "User-Agent": "Mozilla/5.0",
        "CF-IPCountry": "AE",
        "CF-Connecting-IP": "203.0.113.9, 10.0.0.1",
        "Accept": "text/html",
      }),
      AT,
    );
    expect(s.userAgent).toBe("Mozilla/5.0");
    expect(s.country).toBe("AE");
    expect(s.ip).toBe("203.0.113.9"); // first hop only
    expect(s.headerNames).toContain("user-agent");
    expect(s.headerNames.every((h) => h === h.toLowerCase())).toBe(true);
    expect(s.url.pathname).toBe("/path");
  });
});

describe("evaluateRequest (reuses the real engine + bundled ruleset)", () => {
  it("BLOCKS a request that hits an invisible honeypot (decoy trip)", () => {
    const trap = DEFAULT_RULESET.trapPaths[0];
    const s = requestSignals(req(`https://site.example${trap}`, { "User-Agent": "curl/8" }), AT);
    const { verdict } = evaluateRequest("beforeutrade", s, DEFAULT_RULESET);
    expect(verdict.block).toBe(true);
    expect(verdict.reasonKind).toBe("decoy");
  });

  it("BLOCKS a request carrying an injection payload in the query", () => {
    const s = requestSignals(req("https://site.example/search?q=%2e%2e%2f%2e%2e%2fetc%2fpasswd", { "User-Agent": "x" }), AT);
    const { verdict } = evaluateRequest("beforeutrade", s, DEFAULT_RULESET);
    expect(verdict.block).toBe(true);
    expect(verdict.reasonKind).toBe("payload");
    expect(verdict.attack).toBe("path_traversal");
  });

  it("does NOT block a normal browser page view, and produces an observation", () => {
    const s = requestSignals(
      req("https://site.example/", {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml",
        "Sec-Fetch-Dest": "document",
      }),
      AT,
    );
    const { verdict, observation } = evaluateRequest("beforeutrade", s, DEFAULT_RULESET);
    expect(verdict.block).toBe(false);
    expect(observation).not.toBeNull();
    expect(observation?.path).toBe("/");
  });

  it("is safe-by-default: a bare recon probe is recorded, not blocked", () => {
    // A sensitive path with no payload and no attack-tool UA is report-only.
    const s = requestSignals(req("https://site.example/.env", { "User-Agent": "Mozilla/5.0" }), AT);
    const { verdict } = evaluateRequest("beforeutrade", s, DEFAULT_RULESET);
    expect(verdict.block).toBe(false); // precision-first: a probe hint is not proof
  });
});

describe("new contract fields (ip, asn/asOrg, authenticated, platform)", () => {
  function cfReq(url: string, headers: Record<string, string>, cf?: Record<string, unknown>): Request {
    const r = new Request(url, { headers });
    if (cf) Object.defineProperty(r, "cf", { value: cf });
    return r;
  }

  it("reads asn + asOrg from request.cf when Cloudflare provides them", () => {
    const s = requestSignals(cfReq("https://site.example/", { "CF-Connecting-IP": "203.0.113.9" }, { asn: 16509, asOrganization: "Amazon.com, Inc." }), AT);
    expect(s.ip).toBe("203.0.113.9");
    expect(s.asn).toBe(16509);
    expect(s.asOrg).toBe("Amazon.com, Inc.");
  });

  it("omits asn/asOrg when request.cf is absent or malformed", () => {
    expect(requestSignals(req("https://site.example/"), AT).asn).toBeUndefined();
    const s = requestSignals(cfReq("https://site.example/", {}, { asn: "16509", asOrganization: 42 }), AT);
    expect(s.asn).toBeUndefined();
    expect(s.asOrg).toBeUndefined();
  });

  it("takes the client IP ONLY from CF-Connecting-IP, never from forgeable X-Forwarded-For / X-Real-IP", () => {
    const s = requestSignals(req("https://site.example/", { "X-Forwarded-For": "66.249.66.1", "X-Real-IP": "66.249.66.1" }), AT);
    expect(s.ip).toBe("");
  });

  it("authenticated defaults to false and is true only when attested", () => {
    expect(requestSignals(req("https://site.example/"), AT).authenticated).toBe(false);
    expect(requestSignals(req("https://site.example/"), AT, { authenticated: true }).authenticated).toBe(true);
  });

  it("NEVER blocks an attested signed-in request, even a proven-hostile one with enforce on", () => {
    const trap = DEFAULT_RULESET.trapPaths[0];
    const s = requestSignals(req(`https://site.example${trap}`, { "User-Agent": "curl/8" }), AT, { authenticated: true });
    const { verdict } = evaluateRequest("beforeutrade", s, DEFAULT_RULESET);
    expect(verdict.block).toBe(true); // the engine still sees it for what it is
    expect(shouldBlock(verdict, s, true)).toBe(false); // but the connector never blocks a signed-in user
  });

  it("shouldBlock: blocks only a hostile verdict, with enforce on, for an anonymous request", () => {
    const anon = requestSignals(req("https://site.example/"), AT);
    const hostile = { block: true, reason: "x" };
    expect(shouldBlock(hostile, anon, true)).toBe(true);
    expect(shouldBlock(hostile, anon, false)).toBe(false); // watch-first
    expect(shouldBlock({ block: false, reason: "ok" }, anon, true)).toBe(false);
  });

  it("workerAuthenticated: only a literal true counts; a throw or rejection is anonymous", async () => {
    const env = { FORCEFIELD_SITE: "s", FORCEFIELD_ORIGIN: "https://o" };
    const r = req("https://site.example/", { cookie: "session=1" });
    expect(await workerAuthenticated(r, env, {})).toBe(false); // a cookie alone proves nothing
    expect(await workerAuthenticated(r, env, { isAuthenticated: async () => true })).toBe(true);
    expect(await workerAuthenticated(r, env, { isAuthenticated: () => { throw new Error("x"); } })).toBe(false);
    expect(await workerAuthenticated(r, env, { isAuthenticated: () => Promise.reject(new Error("x")) })).toBe(false);
    expect(await workerAuthenticated(r, env, { isAuthenticated: () => 1 as unknown as boolean })).toBe(false);
  });

  it("evaluateRequest still produces an observation for a WordPress origin with the platform declared", () => {
    const s = requestSignals(req("https://site.example/wp-login.php", { "User-Agent": "Mozilla/5.0", "CF-Connecting-IP": "203.0.113.9" }), AT);
    const { verdict, observation } = evaluateRequest("blog", s, DEFAULT_RULESET, { platform: "wordpress" });
    expect(verdict.block).toBe(false);
    expect(observation).not.toBeNull();
  });

  it("evaluateRequest blocks and records a body-proven attack passed in as bodyAttack", () => {
    const s = requestSignals(req("https://site.example/wp-admin/admin-ajax.php", { "User-Agent": "Mozilla/5.0" }), AT);
    const { verdict, observation } = evaluateRequest("blog", s, DEFAULT_RULESET, { platform: "wordpress", bodyAttack: "php2shell" });
    expect(verdict.block).toBe(true);
    expect(verdict.reasonKind).toBe("payload");
    expect(verdict.attack).toBe("php2shell");
    expect(observation?.type).toBe("site.agent_payload_attack");
    expect(observation?.props.attack).toBe("php2shell");
    expect(observation?.props.cwe).toBe("CWE-787"); // KEV enrichment can annotate from here
  });

  it("evaluateRequest without a bodyAttack is unaffected (recorded traffic replays identically)", () => {
    const s = requestSignals(req("https://site.example/wp-admin/admin-ajax.php", { "User-Agent": "Mozilla/5.0" }), AT);
    const { verdict } = evaluateRequest("blog", s, DEFAULT_RULESET, { platform: "wordpress" });
    expect(verdict.block).toBe(false);
  });
});

describe("inspectBodyBounded (bounded body read, clone never disturbs the origin body)", () => {
  function php2shellBody(): string {
    let out = "";
    out += '--B\r\nContent-Disposition: form-data; name="PHP_SESSION_UPLOAD_PROGRESS"\r\n\r\nx\r\n';
    out += '--B\r\nContent-Disposition: form-data; name="files[a][b][c][d][e][f]"\r\n\r\ny\r\n';
    out += "--B--\r\n";
    return out;
  }

  it("detects PHP2Shell in a multipart POST body", async () => {
    const r = new Request("https://site.example/upload.php", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=B" },
      body: php2shellBody(),
    });
    expect(await inspectBodyBounded(r)).toBe("php2shell");
    // The original request body is still readable (the inspection used a clone).
    expect(await r.text()).toContain("PHP_SESSION_UPLOAD_PROGRESS");
  });

  it("detects React2Shell in a Server Action POST body", async () => {
    const body = '--B\r\nContent-Disposition: form-data; name="1_$ACTION"\r\n\r\n[{"x":"$1:__proto__:then"}]\r\n--B--\r\n';
    const r = new Request("https://site.example/", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=B", "next-action": "x" },
      body,
    });
    expect(await inspectBodyBounded(r)).toBe("react2shell");
  });

  it("returns null for a benign multipart upload", async () => {
    const body = '--B\r\nContent-Disposition: form-data; name="file"; filename="photo.jpg"\r\n\r\nJFIF...\r\n--B--\r\n';
    const r = new Request("https://site.example/upload", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=B" },
      body,
    });
    expect(await inspectBodyBounded(r)).toBeNull();
  });

  it("returns null for a GET (no body to inspect)", async () => {
    expect(await inspectBodyBounded(req("https://site.example/"))).toBeNull();
  });
});
