import { classifyClient, headerSignature, DEFAULT_TOOL_SIGNATURES , operatorFingerprint, judgeableBrowserClaim } from "@/lib/forcefield-web/fingerprint"

describe("classifyClient - name the tool, resolve the actor", () => {
  it("names a scanner (strongest hostile tell), outranking its base library", () => {
    expect(classifyClient("sqlmap/1.7").clientType).toBe("scanner");
    expect(classifyClient("sqlmap/1.7").tool).toBe("sqlmap");
    expect(classifyClient("Mozilla/5.0 zgrab/0.x").clientType).toBe("scanner");
  });

  it("names scripted HTTP libraries", () => {
    expect(classifyClient("python-requests/2.31").tool).toBe("python-requests");
    expect(classifyClient("curl/8.4.0").tool).toBe("curl");
    expect(classifyClient("Go-http-client/2.0").tool).toBe("Go-http-client");
  });

  it("flags a headless / automated browser", () => {
    expect(classifyClient("Mozilla/5.0 HeadlessChrome/120").clientType).toBe("headless");
  });

  it("recognizes a known crawler", () => {
    expect(classifyClient("Mozilla/5.0 (compatible; Googlebot/2.1)").clientType).toBe("known_crawler");
  });

  it("calls a real browser with the header trinity a browser", () => {
    const r = classifyClient("Mozilla/5.0 (Macintosh)", ["accept", "accept-language", "accept-encoding", "cookie"]);
    expect(r.clientType).toBe("browser");
    expect(r.headerMismatch).toBe(false);
  });

  it("flags a UA that CLAIMS a browser but lacks the header shape (spoof tell)", () => {
    const r = classifyClient("Mozilla/5.0 (Windows NT 10.0)", ["accept"]);
    expect(r.clientType).toBe("unknown");
    expect(r.headerMismatch).toBe(true);
  });

  it("accepts injected signatures (the central-ruleset seam), falling back to bundled", () => {
    const custom = [["NewScanner2026", "newscanner2026", "scanner"] as const];
    expect(classifyClient("NewScanner2026/1", [], custom).tool).toBe("NewScanner2026");
    // without the injected set, the bundled defaults still work
    expect(classifyClient("curl/8", [], DEFAULT_TOOL_SIGNATURES).tool).toBe("curl");
  });
});

describe("headerSignature", () => {
  it("is deterministic and differs by header set (survives UA spoofing)", () => {
    const browserish = ["host", "accept", "accept-language", "accept-encoding", "cookie", "user-agent"];
    const botish = ["host", "user-agent", "accept-encoding"];
    expect(headerSignature(browserish)).toBe(headerSignature(browserish));
    expect(headerSignature(browserish)).not.toBe(headerSignature(botish));
  });
});


describe("operatorFingerprint - header shape bound to the tool", () => {
  const H = ["host", "user-agent", "accept-encoding"];
  it("binds the tool so the same header shape with a DIFFERENT tool is a different fingerprint", () => {
    const sqlmap = operatorFingerprint(H, "sqlmap", "scanner");
    const legit = operatorFingerprint(H, "acme-integration", "scripted_library");
    expect(sqlmap).not.toBe(legit); // same headers, different tool -> not the same actor
    expect(sqlmap).toContain(":sqlmap");
  });
  it("falls back to client type when there is no named tool", () => {
    expect(operatorFingerprint(H, undefined, "headless")).toContain(":headless");
    expect(operatorFingerprint(H, undefined, undefined)).toContain(":unknown");
  });
  it("is stable: same inputs -> same fingerprint", () => {
    expect(operatorFingerprint(H, "curl")).toBe(operatorFingerprint(H, "curl"));
  });
});

describe("spoofed browsers: a modern Chromium / Firefox claim must carry Fetch Metadata", () => {
  const TRINITY = ["host", "user-agent", "accept", "accept-language", "accept-encoding"];
  const FETCH_META = ["sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest"];
  const CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
  const EDGE = `${CHROME} Edg/130.0.0.0`;
  const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";
  const FIREFOX = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0";
  const SAFARI_OLD = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.6 Safari/605.1.15";
  const IOS_CHROME = "Mozilla/5.0 (iPhone; CPU iPhone OS 15_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.6723.90 Mobile/15E148 Safari/604.1";
  const CHROME_OLD = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/75.0.3770.100 Safari/537.36";

  it.each([CHROME, EDGE, ANDROID, FIREFOX])("a real modern browser (with Fetch Metadata) stays a browser: %s", (ua) => {
    expect(classifyClient(ua, [...TRINITY, ...FETCH_META])).toEqual({ clientType: "browser", headerMismatch: false });
  });

  it.each([CHROME, EDGE, ANDROID, FIREFOX])("the same claim without Fetch Metadata is a spoofed browser: %s", (ua) => {
    expect(classifyClient(ua, TRINITY)).toEqual({ clientType: "unknown", headerMismatch: true, spoof: "no_fetch_metadata" });
  });

  it.each([SAFARI_OLD, IOS_CHROME, CHROME_OLD])("never judged where the browser may not send it (Safari, iOS, pre-cut-off): %s", (ua) => {
    expect(classifyClient(ua, TRINITY)).toEqual({ clientType: "browser", headerMismatch: false });
  });

  it("one of the Fetch Metadata headers is enough (mode or dest)", () => {
    expect(classifyClient(CHROME, [...TRINITY, "sec-fetch-dest"]).clientType).toBe("browser");
    expect(classifyClient(CHROME, [...TRINITY, "sec-fetch-mode"]).clientType).toBe("browser");
  });

  it("a missing accept trinity keeps its own reason", () => {
    expect(classifyClient(CHROME, ["host", "user-agent"])).toEqual({ clientType: "unknown", headerMismatch: true, spoof: "missing_browser_headers" });
  });

  it("judgeableBrowserClaim parses the family and major version, and refuses what it cannot judge", () => {
    expect(judgeableBrowserClaim(CHROME)).toEqual({ family: "chromium", major: 130 });
    expect(judgeableBrowserClaim(FIREFOX)).toEqual({ family: "firefox", major: 131 });
    expect(judgeableBrowserClaim(SAFARI_OLD)).toBeNull();
    expect(judgeableBrowserClaim(IOS_CHROME)).toBeNull();
    expect(judgeableBrowserClaim(CHROME_OLD)).toBeNull();
  });
});
