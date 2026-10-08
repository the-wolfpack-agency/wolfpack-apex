/** @jest-environment node */
/**
 * Tenant quick-start: the ready-to-paste adapter config a newly-onboarded tenant
 * gets. Pins that it carries the token + site and is watch-first (enforcement off
 * until the client turns it on).
 */
import { buildTenantQuickstart } from "../tenant-quickstart";

const tenant = { id: "t1", name: "Before U Trade", siteLabel: "beforeutrade", status: "active" as const, createdAt: "2026-10-06T00:00:00Z" };

describe("buildTenantQuickstart", () => {
  it("carries the token and site into both adapter configs", () => {
    const qs = buildTenantQuickstart(tenant, "ff_tok");
    expect(qs.token).toBe("ff_tok");
    expect(qs.cloudflareEnv.SITE_ANALYTICS_INGEST_TOKEN).toBe("ff_tok");
    expect(qs.nextEnv.SITE_ANALYTICS_INGEST_TOKEN).toBe("ff_tok");
    expect(qs.cloudflareEnv.FORCEFIELD_SITE).toBe("beforeutrade");
    expect(qs.nextEnv.FORCEFIELD_SITE).toBe("beforeutrade");
  });

  it("is watch-first: enforcement is OFF until the client turns it on", () => {
    expect(buildTenantQuickstart(tenant, "ff_tok").cloudflareEnv.FORCEFIELD_ENFORCE).toBe("off");
  });

  it("points at the control-plane ingest + ruleset endpoints", () => {
    const qs = buildTenantQuickstart(tenant, "ff_tok");
    expect(qs.ingestUrl).toMatch(/\/api\/site-analytics\/ingest$/);
    expect(qs.rulesetUrl).toMatch(/\/api\/forcefield\/ruleset$/);
    expect(qs.nextSnippet).toContain("@ogiam/forcefield/next");
  });

  it("defaults a platform-less tenant to the generic door (both adapters) for back-compat", () => {
    const qs = buildTenantQuickstart(tenant, "ff_tok");
    expect(qs.platform).toBe("generic");
    expect(qs.connector.emits).toEqual({ next: true, cloudflare: true });
    expect(qs.connector.managed).toBe(false);
  });

  it("tailors the door to the tenant's platform: Vercel is next-only, not Cloudflare", () => {
    const qs = buildTenantQuickstart({ ...tenant, platform: "vercel" }, "ff_tok");
    expect(qs.platform).toBe("vercel");
    expect(qs.connector.emits).toEqual({ next: true, cloudflare: false });
    expect(qs.connector.steps.length).toBeGreaterThan(0);
  });

  it("a hosted (we-host) tenant is managed: nothing to install", () => {
    const qs = buildTenantQuickstart({ ...tenant, platform: "hosted" }, "ff_tok");
    expect(qs.connector.managed).toBe(true);
    expect(qs.connector.emits).toEqual({ next: false, cloudflare: false });
  });
});
