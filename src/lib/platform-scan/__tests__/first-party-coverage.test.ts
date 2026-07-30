/**
 * Guardrail: every first-party product that has a public URL (in the /products
 * catalog, src/lib/products.ts) must be a curated, ownership-exempt platform-scan
 * target. This is what keeps scan coverage from silently missing a product: add a
 * URL in products.ts and this test fails until a scan manifest is registered for
 * it, so the two sources cannot drift.
 *
 * manifests.ts imports the connector + stored-target registries (which pull in
 * @/lib/db); mock them so importing the curated map stays DB-free.
 */
jest.mock("@/lib/assistant/connectors/credentials", () => ({
  loadConnectorCredentials: jest.fn(),
  listConnectorCredentials: jest.fn(),
}));
jest.mock("@/lib/platform-scan/targets-store", () => ({
  getStoredScanTarget: jest.fn(),
  listStoredTargets: jest.fn(),
}));

import { SCAN_MANIFESTS, isCuratedTarget } from "@/lib/platform-scan/manifests";
import { PRODUCTS } from "@/lib/products";

const norm = (u: string) => u.replace(/\/+$/, "");
const manifestUrls = new Set(Object.values(SCAN_MANIFESTS).map((m) => norm(m.baseUrl)));

describe("first-party scan coverage", () => {
  const productsWithUrl = PRODUCTS.filter((p) => p.url);

  it("has products with URLs to cover", () => {
    expect(productsWithUrl.length).toBeGreaterThan(0);
  });

  it.each(productsWithUrl.map((p) => [p.name, p.url as string]))(
    "%s (%s) is a curated scan target",
    (_name, url) => {
      expect(manifestUrls.has(norm(url))).toBe(true);
    },
  );

  it("every curated manifest is ownership-exempt", () => {
    for (const platform of Object.keys(SCAN_MANIFESTS)) {
      expect(isCuratedTarget(platform)).toBe(true);
    }
  });

  it("every curated manifest has an https base URL, a slug-safe key, and at least one route", () => {
    for (const [platform, m] of Object.entries(SCAN_MANIFESTS)) {
      expect(m.baseUrl).toMatch(/^https:\/\//);
      expect(platform).toMatch(/^[a-z0-9-]+$/);
      expect(m.routes.length).toBeGreaterThan(0);
    }
  });
});
