import { classifyClient, headerSignature, DEFAULT_TOOL_SIGNATURES , operatorFingerprint } from "@/lib/forcefield-web/fingerprint"

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
