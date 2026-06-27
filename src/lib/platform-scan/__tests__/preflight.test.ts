/**
 * runPreflight: non-destructive readiness checks before a real engagement.
 * Critical checks gate readiness (ok); advisories (repo_accessible) do not.
 * The four collaborators (resolveScanTarget, assertScannableUrl,
 * discoverRepoFiles, loadConnectorCredentials) are mocked; the reachability GET
 * is injected via deps.fetchImpl.
 */
const mockResolveTarget = jest.fn();
const mockAssertUrl = jest.fn();
const mockDiscoverFiles = jest.fn();
const mockLoadCreds = jest.fn();

jest.mock("@/lib/platform-scan/manifests", () => ({
  resolveScanTarget: (...a: unknown[]) => mockResolveTarget(...a),
}));
jest.mock("@/lib/platform-scan/ssrf-guard", () => {
  class SsrfBlockedError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "SsrfBlockedError";
    }
  }
  return {
    assertScannableUrl: (...a: unknown[]) => mockAssertUrl(...a),
    SsrfBlockedError,
  };
});
jest.mock("@/lib/platform-scan/static/discover-files", () => ({
  discoverRepoFiles: (...a: unknown[]) => mockDiscoverFiles(...a),
}));
jest.mock("@/lib/assistant/connectors/credentials", () => ({
  loadConnectorCredentials: (...a: unknown[]) => mockLoadCreds(...a),
}));

import { runPreflight, type PreflightResult } from "@/lib/platform-scan/preflight";
import { SsrfBlockedError } from "@/lib/platform-scan/ssrf-guard";

const HTTP_ONLY = { baseUrl: "https://target.example", routes: [] };
const STATIC_TARGET = {
  baseUrl: "https://target.example",
  routes: [],
  static: { owner: "the-wolfpack-agency", repo: "wolfpack-auto", ref: "main", paths: ["a.tsx"] },
};
const LOGIN_TARGET = {
  baseUrl: "https://beyond.example",
  routes: [],
  login: { connectorName: "wolfpack-beyond", loginPath: "/api/auth/login", sessionCookieName: "session" },
};

const okFetch = jest.fn(async () => ({ status: 200 }) as Response);

function check(result: PreflightResult, name: string) {
  return result.checks.find((c) => c.name === name);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockResolveTarget.mockResolvedValue({ ...HTTP_ONLY });
  mockAssertUrl.mockResolvedValue(undefined);
  mockDiscoverFiles.mockResolvedValue([]);
  mockLoadCreds.mockResolvedValue(null);
  okFetch.mockResolvedValue({ status: 200 } as Response);
});

describe("runPreflight", () => {
  it("unknown platform: resolveScanTarget null -> ok:false, single failed target_resolved check", async () => {
    mockResolveTarget.mockResolvedValue(null);
    const result = await runPreflight("ws-1", "nope", { fetchImpl: okFetch as unknown as typeof fetch });
    expect(result.ok).toBe(false);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]).toMatchObject({ name: "target_resolved", pass: false, critical: true });
    expect(okFetch).not.toHaveBeenCalled();
  });

  it("happy path http-only target reachable 200 -> ok:true", async () => {
    mockResolveTarget.mockResolvedValue({ ...HTTP_ONLY });
    const result = await runPreflight("ws-1", "wolfpack-auto", { fetchImpl: okFetch as unknown as typeof fetch });
    expect(result.ok).toBe(true);
    expect(check(result, "target_resolved")?.pass).toBe(true);
    expect(check(result, "base_url_public")?.pass).toBe(true);
    expect(check(result, "base_url_reachable")?.pass).toBe(true);
    expect(okFetch).toHaveBeenCalledWith(HTTP_ONLY.baseUrl, { method: "GET", redirect: "manual" });
    // no static, no login -> those checks are absent.
    expect(check(result, "repo_accessible")).toBeUndefined();
    expect(check(result, "login_credentials")).toBeUndefined();
  });

  it("SSRF-blocked baseUrl: base_url_public fails and ok:false (no reachability attempt)", async () => {
    mockAssertUrl.mockRejectedValue(new SsrfBlockedError("blocked internal host: localhost"));
    const result = await runPreflight("ws-1", "wolfpack-auto", { fetchImpl: okFetch as unknown as typeof fetch });
    expect(check(result, "base_url_public")).toMatchObject({ pass: false, critical: true });
    expect(result.ok).toBe(false);
    expect(check(result, "base_url_reachable")).toBeUndefined();
    expect(okFetch).not.toHaveBeenCalled();
  });

  it("reachability fetch throws: base_url_reachable fails", async () => {
    okFetch.mockRejectedValue(new Error("ECONNREFUSED"));
    const result = await runPreflight("ws-1", "wolfpack-auto", { fetchImpl: okFetch as unknown as typeof fetch });
    expect(check(result, "base_url_public")?.pass).toBe(true);
    expect(check(result, "base_url_reachable")).toMatchObject({ pass: false, critical: true });
    expect(result.ok).toBe(false);
  });

  it("static target with repo files discovered: repo_accessible passes (advisory, critical:false)", async () => {
    mockResolveTarget.mockResolvedValue({ ...STATIC_TARGET });
    mockDiscoverFiles.mockResolvedValue(["a.tsx", "b.tsx"]);
    const result = await runPreflight("ws-1", "wolfpack-auto", { fetchImpl: okFetch as unknown as typeof fetch });
    expect(mockDiscoverFiles).toHaveBeenCalledWith("the-wolfpack-agency", "wolfpack-auto", "main");
    expect(check(result, "repo_accessible")).toMatchObject({ pass: true, critical: false });
    expect(result.ok).toBe(true);
  });

  it("static target repo returns 0 files: repo_accessible fails but ok stays true (advisory does not gate)", async () => {
    mockResolveTarget.mockResolvedValue({ ...STATIC_TARGET });
    mockDiscoverFiles.mockResolvedValue([]);
    const result = await runPreflight("ws-1", "wolfpack-auto", { fetchImpl: okFetch as unknown as typeof fetch });
    expect(check(result, "repo_accessible")).toMatchObject({ pass: false, critical: false });
    expect(result.ok).toBe(true);
  });

  it("login-gated target with no creds: login_credentials fails critical -> ok:false", async () => {
    mockResolveTarget.mockResolvedValue({ ...LOGIN_TARGET });
    mockLoadCreds.mockResolvedValue(null);
    const result = await runPreflight("ws-1", "wolfpack-beyond", { fetchImpl: okFetch as unknown as typeof fetch });
    expect(mockLoadCreds).toHaveBeenCalledWith("ws-1", "wolfpack-beyond");
    expect(check(result, "login_credentials")).toMatchObject({ pass: false, critical: true });
    expect(result.ok).toBe(false);
  });

  it("login-gated target with creds present: login_credentials passes -> ok:true", async () => {
    mockResolveTarget.mockResolvedValue({ ...LOGIN_TARGET });
    mockLoadCreds.mockResolvedValue({ authType: "username_password", username: "u", password: "p" });
    const result = await runPreflight("ws-1", "wolfpack-beyond", { fetchImpl: okFetch as unknown as typeof fetch });
    expect(check(result, "login_credentials")).toMatchObject({ pass: true, critical: true });
    expect(result.ok).toBe(true);
  });
});
