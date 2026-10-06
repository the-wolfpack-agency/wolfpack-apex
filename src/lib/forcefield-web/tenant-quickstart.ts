/**
 * Self-serve quick-start: everything a newly-onboarded Forcefield tenant needs to
 * go live, built from its token + site. The raw token appears only here (it is
 * stored hashed), so this is returned once at creation and never reconstructable
 * later. The client picks ONE adapter.
 */
import type { ForcefieldTenant } from "./tenants";

/** The OGIAM control-plane endpoints a client's adapter points at. Overridable by
 *  env for a different deployment; the defaults are the production endpoints. */
function controlPlane() {
  const base = process.env.FORCEFIELD_PUBLIC_BASE_URL || "https://wolfpack-instinct.vercel.app";
  return {
    ingestUrl: `${base}/api/site-analytics/ingest`,
    rulesetUrl: `${base}/api/forcefield/ruleset`,
  };
}

export interface TenantQuickstart {
  /** The ingest token the client configures (shown once). */
  token: string;
  ingestUrl: string;
  rulesetUrl: string;
  /** Copy-paste env for the Cloudflare Worker adapter (any origin). */
  cloudflareEnv: Record<string, string>;
  /** Copy-paste env for the in-app (Next.js) middleware adapter. */
  nextEnv: Record<string, string>;
  /** The one-line in-app middleware wiring. */
  nextSnippet: string;
}

export function buildTenantQuickstart(tenant: ForcefieldTenant, token: string): TenantQuickstart {
  const { ingestUrl, rulesetUrl } = controlPlane();
  const common = {
    FORCEFIELD_SITE: tenant.siteLabel,
    FORCEFIELD_WEB: "on",
    SITE_ANALYTICS_INGEST_TOKEN: token,
    FORCEFIELD_INGEST_URL: ingestUrl,
    FORCEFIELD_RULESET_URL: rulesetUrl,
    // Watch-first: blocking is off until the client deliberately turns it on.
    FORCEFIELD_ENFORCE: "off",
  };
  return {
    token,
    ingestUrl,
    rulesetUrl,
    cloudflareEnv: { ...common, FORCEFIELD_ORIGIN: "https://your-site.example" },
    nextEnv: common,
    nextSnippet:
      'export { default as middleware } from "@ogiam/forcefield/next";\n' +
      'export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };',
  };
}
