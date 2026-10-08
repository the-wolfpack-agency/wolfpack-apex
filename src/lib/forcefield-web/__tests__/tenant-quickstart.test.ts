/** @jest-environment node */
/**
 * Tenant quick-start: the ready-to-paste adapter config a newly-onboarded tenant
 * gets. Pins that it carries the token + site and is watch-first (enforcement off
 * until the client turns it on).
 */
import { buildTenantQuickstart } from "../tenant-quickstart";

const tenant = { id: "t1", name: "Before U Trade", siteLabel: "beforeutrade", status: "active" as const, createdAt: "2026-10-06T00:00:00Z" };

describe("buildTenantQuickstart", () => {
  it("carries the token and site into both adapter configs (per adapter's auth model)", () => {
    const qs = buildTenantQuickstart(tenant, "ff_tok");
    expect(qs.token).toBe("ff_tok");
    // Cloudflare Worker: token is the ingest secret for the recording path.
    expect(qs.cloudflareEnv.SITE_ANALYTICS_INGEST_TOKEN).toBe("ff_tok");
    // Next shim: token authorizes the engine (observe) call directly.
    expect(qs.nextEnv.FORCEFIELD_EDGE_TOKEN).toBe("ff_tok");
    expect(qs.nextEnv.FORCEFIELD_INGEST_URL).toMatch(/\/api\/forcefield\/observe$/);
    expect(qs.cloudflareEnv.FORCEFIELD_SITE).toBe("beforeutrade");
    expect(qs.nextEnv.FORCEFIELD_SITE).toBe("beforeutrade");
  });

  it("is watch-first: enforcement is OFF until the client turns it on", () => {
    const qs = buildTenantQuickstart(tenant, "ff_tok");
    expect(qs.cloudflareEnv.FORCEFIELD_ENFORCE).toBe("off");
    expect(qs.nextEnv.FORCEFIELD_ENFORCE).toBe("off");
  });

  it("points at the control-plane ingest + ruleset + observe endpoints", () => {
    const qs = buildTenantQuickstart(tenant, "ff_tok");
    expect(qs.ingestUrl).toMatch(/\/api\/site-analytics\/ingest$/);
    expect(qs.rulesetUrl).toMatch(/\/api\/forcefield\/ruleset$/);
    expect(qs.observeUrl).toMatch(/\/api\/forcefield\/observe$/);
  });

  it("emits a REAL self-contained middleware file (no non-existent @ogiam package)", () => {
    const src = buildTenantQuickstart(tenant, "ff_tok").nextSnippet;
    expect(src).not.toContain("@ogiam/forcefield");
    expect(src).toContain("export async function middleware");
    expect(src).toContain('"x-edge-token"');
    expect(src).toContain("export const config");
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
