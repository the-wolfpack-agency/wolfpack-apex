/**
 * resolveScanTarget + listScanTargets: a curated platform OR a saved client
 * connection is scannable, so any system an operator connects (username/password)
 * becomes a target — not just our hardcoded platforms. The credential vault is
 * mocked.
 */
const mockLoad = jest.fn();
const mockList = jest.fn();
const mockGetStored = jest.fn();
const mockListStored = jest.fn();
jest.mock("@/lib/assistant/connectors/credentials", () => ({
  loadConnectorCredentials: (...a: unknown[]) => mockLoad(...a),
  listConnectorCredentials: (...a: unknown[]) => mockList(...a),
}));
// resolveScanTarget/listScanTargets now consult the stored-target registry, which
// imports @/lib/db. Mock the registry so the curated/connector tests stay isolated
// from the DB (default: no stored targets).
jest.mock("@/lib/platform-scan/targets-store", () => ({
  getStoredScanTarget: (...a: unknown[]) => mockGetStored(...a),
  listStoredTargets: (...a: unknown[]) => mockListStored(...a),
}));

import { resolveScanTarget, listScanTargets } from "@/lib/platform-scan/manifests";

beforeEach(() => {
  jest.clearAllMocks();
  mockLoad.mockResolvedValue(null);
  mockList.mockResolvedValue([]);
  mockGetStored.mockResolvedValue(null);
  mockListStored.mockResolvedValue([]);
});

describe("resolveScanTarget", () => {
  it("returns the curated manifest for a known platform (no DB lookup needed)", async () => {
    const m = await resolveScanTarget("ws-1", "wolfpack-beyond");
    expect(m?.baseUrl).toBe("https://beyond-sku.vercel.app");
    expect(m?.login?.loginPath).toBe("/api/auth/login");
  });

  it("returns a STORED onboarded target and does NOT fall through to the connector", async () => {
    const stored = {
      baseUrl: "https://onboarded.client.com",
      routes: [{ path: "/admin", journey: "Admin", auth: "required" as const }],
      static: { owner: "o", repo: "r", ref: "main", paths: ["a"] },
    };
    mockGetStored.mockResolvedValue(stored);
    const m = await resolveScanTarget("ws-1", "onboarded-acme");
    expect(mockGetStored).toHaveBeenCalledWith("ws-1", "onboarded-acme");
    expect(m).toBe(stored);
    expect(mockLoad).not.toHaveBeenCalled(); // no connector fallthrough
  });

  it("falls through to the connector when no stored target exists", async () => {
    mockGetStored.mockResolvedValue(null);
    mockLoad.mockResolvedValue({
      baseUrl: "https://app.client.com", authType: "username_password",
      username: "u", password: "p", loginPath: "/auth/login", sessionCookieName: "sid",
    });
    const m = await resolveScanTarget("ws-1", "acme-portal");
    expect(mockGetStored).toHaveBeenCalledWith("ws-1", "acme-portal");
    expect(mockLoad).toHaveBeenCalledWith("ws-1", "acme-portal");
    expect(m?.baseUrl).toBe("https://app.client.com");
  });

  it("builds an ad-hoc manifest from a saved username/password connection", async () => {
    mockLoad.mockResolvedValue({
      baseUrl: "https://app.client.com", authType: "username_password",
      username: "u", password: "p", loginPath: "/auth/login", sessionCookieName: "sid",
    });
    const m = await resolveScanTarget("ws-1", "acme-portal");
    expect(mockLoad).toHaveBeenCalledWith("ws-1", "acme-portal");
    expect(m?.baseUrl).toBe("https://app.client.com");
    expect(m?.login).toEqual({ connectorName: "acme-portal", loginPath: "/auth/login", sessionCookieName: "sid" });
    expect(m?.routes.length).toBeGreaterThan(0); // default routes (sitemap unions on top)
  });

  it("builds an oauth_password (Salesforce) target with the token login path + a default REST probe", async () => {
    mockLoad.mockResolvedValue({
      baseUrl: "https://test.salesforce.com", authType: "oauth_password",
      clientId: "cid", clientSecret: "sec", username: "i@acme.com", password: "pw", loginPath: "/services/oauth2/token",
    });
    const m = await resolveScanTarget("ws-1", "salesforce-sbx");
    expect(m?.baseUrl).toBe("https://test.salesforce.com");
    expect(m?.login).toEqual({ connectorName: "salesforce-sbx", loginPath: "/services/oauth2/token", sessionCookieName: "" });
    expect(m?.apiEndpoints?.[0]).toMatchObject({ path: "/services/data/", method: "GET", requiresAuth: true });
  });

  it("a non-login connection still resolves but without a login config", async () => {
    mockLoad.mockResolvedValue({ baseUrl: "https://api.client.com", authType: "static_bearer" });
    const m = await resolveScanTarget("ws-1", "some-api");
    expect(m?.login).toBeUndefined();
  });

  it("returns null when neither a manifest nor a connection exists", async () => {
    expect(await resolveScanTarget("ws-1", "nope")).toBeNull();
  });
});

describe("listScanTargets", () => {
  it("merges curated manifests with saved connections (curated wins on name)", async () => {
    mockList.mockResolvedValue([
      { connectorName: "acme-portal", baseUrl: "https://app.client.com", authType: "username_password", isActive: true },
      { connectorName: "wolfpack-beyond", baseUrl: "https://dupe", authType: "username_password", isActive: true }, // collides with curated
      { connectorName: "inactive", baseUrl: "https://x", authType: "username_password", isActive: false }, // dropped
    ]);
    const targets = await listScanTargets("ws-1");
    const acme = targets.find((t) => t.platform === "acme-portal");
    expect(acme).toMatchObject({ baseUrl: "https://app.client.com", hasLogin: true, hasStatic: false, hasApi: false });
    // curated wolfpack-beyond kept (not the connection dupe), inactive dropped.
    expect(targets.filter((t) => t.platform === "wolfpack-beyond")).toHaveLength(1);
    expect(targets.find((t) => t.platform === "wolfpack-beyond")?.baseUrl).toBe("https://beyond-sku.vercel.app");
    expect(targets.find((t) => t.platform === "inactive")).toBeUndefined();
  });
});
