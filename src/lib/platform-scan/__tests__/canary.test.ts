/**
 * runDemoCanary + parseCanaryTargets — the demo-login canary unit suite.
 *
 * Pins the regression-catching contract:
 *   - logs in + scans + meets expectMinFindings        → healthy
 *   - login fails (session dep returns null)            → unhealthy, loginOk:false
 *   - scan returns < expectMinFindings                  → unhealthy (the regression case)
 *   - a thrown session/scan dep                         → unhealthy with reason, no crash
 *   - oauth_password vs username_password               → routed to the right session fn
 *   - parseCanaryTargets is defensive (bad JSON → [])
 */

import {
  runDemoCanary,
  parseCanaryTargets,
  type CanaryDeps,
  type CanaryTarget,
} from "../canary";
import type { PlatformScanResult } from "../types";
import type { ScanFinding } from "../types";

function scanResult(findingCount: number): PlatformScanResult {
  const findings: ScanFinding[] = Array.from({ length: findingCount }, (_, i) => ({
    route: `/r${i}`,
    severity: "high",
    category: "bug",
    title: `f${i}`,
    detail: "",
    evidence: {},
  }));
  return { platform: "demo", baseUrl: "https://demo.test", routeCount: 5, okCount: 0, findings };
}

function apiFindings(count: number): ScanFinding[] {
  return Array.from({ length: count }, (_, i) => ({
    route: `/api/r${i}`,
    severity: "critical",
    category: "security",
    title: `e${i}`,
    detail: "",
    evidence: {},
  }));
}

/** Build a deps object whose every seam is a jest mock. */
function makeDeps(over: Partial<CanaryDeps> = {}): jest.Mocked<CanaryDeps> {
  return {
    establishSession: jest.fn().mockResolvedValue({ cookie: "session=abc" }),
    establishOAuthPasswordSession: jest
      .fn()
      .mockResolvedValue({ authHeader: "Bearer tok", instanceUrl: "https://inst.test" }),
    scanPlatform: jest.fn().mockResolvedValue(scanResult(3)),
    probeApi: jest.fn().mockResolvedValue(apiFindings(2)),
    ...over,
  } as jest.Mocked<CanaryDeps>;
}

const HTTP_TARGET: CanaryTarget = {
  name: "demo-http",
  baseUrl: "https://demo.test",
  loginPath: "/api/auth/login",
  username: "u@x.test",
  password: "pw",
  authType: "username_password",
  mode: "http",
  expectMinFindings: 1,
};

describe("runDemoCanary", () => {
  it("login + scan + meets expectMinFindings → healthy", async () => {
    const deps = makeDeps({ scanPlatform: jest.fn().mockResolvedValue(scanResult(3)) });
    const [res] = await runDemoCanary([{ ...HTTP_TARGET, expectMinFindings: 2 }], deps);
    expect(res).toEqual({
      name: "demo-http",
      loginOk: true,
      scanOk: true,
      findingCount: 3,
      healthy: true,
    });
    expect(deps.establishSession).toHaveBeenCalledTimes(1);
    expect(deps.scanPlatform).toHaveBeenCalledTimes(1);
    // The scan ran AUTHENTICATED with the session cookie.
    const scanArg = deps.scanPlatform.mock.calls[0][0];
    expect(scanArg.authenticated).toBe(true);
    expect(scanArg.headers).toEqual({ Cookie: "session=abc" });
  });

  it("login fails → unhealthy with loginOk:false, no scan attempted", async () => {
    const deps = makeDeps({ establishSession: jest.fn().mockResolvedValue(null) });
    const [res] = await runDemoCanary([HTTP_TARGET], deps);
    expect(res.healthy).toBe(false);
    expect(res.loginOk).toBe(false);
    expect(res.scanOk).toBe(false);
    expect(res.reason).toMatch(/login failed/i);
    expect(deps.scanPlatform).not.toHaveBeenCalled();
  });

  it("scan returns fewer findings than the floor → unhealthy (the regression case)", async () => {
    const deps = makeDeps({ scanPlatform: jest.fn().mockResolvedValue(scanResult(0)) });
    const [res] = await runDemoCanary([{ ...HTTP_TARGET, expectMinFindings: 1 }], deps);
    expect(res.loginOk).toBe(true);
    expect(res.scanOk).toBe(true);
    expect(res.findingCount).toBe(0);
    expect(res.healthy).toBe(false);
    expect(res.reason).toMatch(/below expected minimum/i);
  });

  it("a thrown scan dep → unhealthy with reason, never crashes", async () => {
    const deps = makeDeps({
      scanPlatform: jest.fn().mockRejectedValue(new Error("boom")),
    });
    const [res] = await runDemoCanary([HTTP_TARGET], deps);
    expect(res.healthy).toBe(false);
    expect(res.reason).toMatch(/error: boom/);
  });

  it("a thrown session dep → unhealthy with reason, never crashes", async () => {
    const deps = makeDeps({
      establishSession: jest.fn().mockRejectedValue(new Error("net down")),
    });
    const [res] = await runDemoCanary([HTTP_TARGET], deps);
    expect(res.healthy).toBe(false);
    expect(res.reason).toMatch(/error: net down/);
  });

  it("routes oauth_password to establishOAuthPasswordSession + scans the instance URL", async () => {
    const deps = makeDeps();
    const target: CanaryTarget = {
      name: "demo-sfdc",
      baseUrl: "https://test.salesforce.com",
      loginPath: "/services/oauth2/token",
      username: "u@x.test",
      password: "pw",
      authType: "oauth_password",
      clientId: "cid",
      clientSecret: "csecret",
      mode: "http",
      expectMinFindings: 1,
    };
    const [res] = await runDemoCanary([target], deps);
    expect(res.healthy).toBe(true);
    expect(deps.establishOAuthPasswordSession).toHaveBeenCalledTimes(1);
    expect(deps.establishSession).not.toHaveBeenCalled();
    const scanArg = deps.scanPlatform.mock.calls[0][0];
    // Scans against the provider-returned instance URL, with a bearer header.
    expect(scanArg.baseUrl).toBe("https://inst.test");
    expect(scanArg.headers).toEqual({ Authorization: "Bearer tok" });
  });

  it("oauth login failure → unhealthy loginOk:false", async () => {
    const deps = makeDeps({
      establishOAuthPasswordSession: jest.fn().mockResolvedValue(null),
    });
    const [res] = await runDemoCanary(
      [{ ...HTTP_TARGET, authType: "oauth_password", clientId: "c", clientSecret: "s" }],
      deps,
    );
    expect(res.loginOk).toBe(false);
    expect(res.healthy).toBe(false);
  });

  it("api mode → probeApi, finding count drives health", async () => {
    const deps = makeDeps({ probeApi: jest.fn().mockResolvedValue(apiFindings(2)) });
    const [res] = await runDemoCanary(
      [{ ...HTTP_TARGET, mode: "api", expectMinFindings: 2 }],
      deps,
    );
    expect(res.healthy).toBe(true);
    expect(res.findingCount).toBe(2);
    expect(deps.probeApi).toHaveBeenCalledTimes(1);
    expect(deps.scanPlatform).not.toHaveBeenCalled();
    const probeArg = deps.probeApi.mock.calls[0][0];
    expect(probeArg.authHeaders).toEqual({ Cookie: "session=abc" });
  });

  it("runs all targets and never throws on a mix", async () => {
    const deps = makeDeps({
      establishSession: jest
        .fn()
        .mockResolvedValueOnce({ cookie: "session=ok" })
        .mockResolvedValueOnce(null),
      scanPlatform: jest.fn().mockResolvedValue(scanResult(5)),
    });
    const results = await runDemoCanary(
      [
        { ...HTTP_TARGET, name: "ok" },
        { ...HTTP_TARGET, name: "broken-login" },
      ],
      deps,
    );
    expect(results).toHaveLength(2);
    expect(results.find((r) => r.name === "ok")?.healthy).toBe(true);
    expect(results.find((r) => r.name === "broken-login")?.healthy).toBe(false);
  });

  it("defaults expectMinFindings to 1", async () => {
    const deps = makeDeps({ scanPlatform: jest.fn().mockResolvedValue(scanResult(1)) });
    const t: CanaryTarget = { ...HTTP_TARGET };
    delete t.expectMinFindings;
    const [res] = await runDemoCanary([t], deps);
    expect(res.healthy).toBe(true);
  });
});

describe("parseCanaryTargets", () => {
  it("returns [] when unset or empty", () => {
    expect(parseCanaryTargets(undefined)).toEqual([]);
    expect(parseCanaryTargets("")).toEqual([]);
    expect(parseCanaryTargets("   ")).toEqual([]);
  });

  it("returns [] on invalid JSON (no crash)", () => {
    expect(parseCanaryTargets("{not json")).toEqual([]);
    expect(parseCanaryTargets("null")).toEqual([]);
    expect(parseCanaryTargets('{"not":"array"}')).toEqual([]);
  });

  it("parses a well-formed array and applies defaults", () => {
    const raw = JSON.stringify([
      {
        name: "demo",
        baseUrl: "https://demo.test",
        loginPath: "/api/auth/login",
        username: "u@x.test",
        password: "pw",
      },
    ]);
    const [t] = parseCanaryTargets(raw);
    expect(t.name).toBe("demo");
    expect(t.authType).toBe("username_password");
    expect(t.mode).toBe("http");
  });

  it("skips entries missing required fields", () => {
    const raw = JSON.stringify([
      { name: "ok", baseUrl: "https://x", loginPath: "/l", username: "u", password: "p" },
      { name: "missing-password", baseUrl: "https://x", loginPath: "/l", username: "u" },
      { baseUrl: "https://x", loginPath: "/l", username: "u", password: "p" },
      "garbage",
      null,
    ]);
    const targets = parseCanaryTargets(raw);
    expect(targets).toHaveLength(1);
    expect(targets[0].name).toBe("ok");
  });

  it("honors oauth_password + api mode + expectMinFindings", () => {
    const raw = JSON.stringify([
      {
        name: "sfdc",
        baseUrl: "https://test.salesforce.com",
        loginPath: "/services/oauth2/token",
        username: "u",
        password: "p",
        authType: "oauth_password",
        clientId: "c",
        clientSecret: "s",
        mode: "api",
        expectMinFindings: 3,
      },
    ]);
    const [t] = parseCanaryTargets(raw);
    expect(t.authType).toBe("oauth_password");
    expect(t.mode).toBe("api");
    expect(t.expectMinFindings).toBe(3);
    expect(t.clientId).toBe("c");
  });
});
