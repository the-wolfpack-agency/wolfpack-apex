/** @jest-environment node */
/**
 * Forcefield connector catalog. Pins the registry invariants the rest of the
 * connector layer relies on: every entry is well-formed, the key guard accepts
 * only cataloged keys, the default is a real available connector, and lookups
 * return isolated copies (a caller cannot mutate the registry).
 */
import { CONNECTORS, listForcefieldConnectors, connectorByKey, isConnectorKey, DEFAULT_CONNECTOR } from "../connectors";

describe("catalog shape", () => {
  it("every connector is well-formed and has unique keys", () => {
    const keys = CONNECTORS.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length); // unique
    for (const c of CONNECTORS) {
      expect(c.key).toBeTruthy();
      expect(c.title).toBeTruthy();
      expect(c.description).toBeTruthy();
      expect(["available", "coming_soon"]).toContain(c.status);
      expect(typeof c.managed).toBe("boolean");
      expect(c.steps.length).toBeGreaterThan(0);
      // A managed (we-host) connector asks the client to install nothing.
      if (c.managed) expect(c.emits).toEqual({ next: false, cloudflare: false });
    }
  });

  it("covers the four target doors plus the generic fallback", () => {
    const keys = CONNECTORS.map((c) => c.key);
    expect(keys).toEqual(expect.arrayContaining(["hosted", "vercel", "cloudflare", "wordpress", "generic"]));
  });

  it("the generic door emits both adapters (back-compat with the pre-connector quick-start)", () => {
    expect(connectorByKey("generic")!.emits).toEqual({ next: true, cloudflare: true });
  });

  it("the hosted door is managed (nothing to install)", () => {
    expect(connectorByKey("hosted")!.managed).toBe(true);
  });
});

describe("isConnectorKey", () => {
  it("accepts only cataloged keys", () => {
    expect(isConnectorKey("vercel")).toBe(true);
    expect(isConnectorKey("generic")).toBe(true);
    expect(isConnectorKey("aws")).toBe(false);
    expect(isConnectorKey("")).toBe(false);
    expect(isConnectorKey(undefined)).toBe(false);
    expect(isConnectorKey(42)).toBe(false);
  });
});

describe("DEFAULT_CONNECTOR", () => {
  it("is a real, available connector", () => {
    const d = connectorByKey(DEFAULT_CONNECTOR);
    expect(d).toBeDefined();
    expect(d!.status).toBe("available");
  });
});

describe("lookups return isolated copies", () => {
  it("mutating a returned connector never changes the registry", () => {
    const c = connectorByKey("vercel")!;
    c.title = "HACKED";
    (c.steps as string[]).push("x");
    c.emits.next = false;
    expect(connectorByKey("vercel")!.title).toBe("Vercel / Next.js");
    expect(connectorByKey("vercel")!.emits.next).toBe(true);
    expect(connectorByKey("vercel")!.steps).not.toContain("x");
  });
  it("connectorByKey returns undefined for an unknown key", () => {
    expect(connectorByKey("nope")).toBeUndefined();
  });
  it("listForcefieldConnectors returns every catalog entry", () => {
    expect(listForcefieldConnectors().map((c) => c.key).sort()).toEqual(CONNECTORS.map((c) => c.key).sort());
  });
});
