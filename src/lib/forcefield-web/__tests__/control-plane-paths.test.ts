/** @jest-environment node */
/**
 * Every Instinct endpoint a site's middleware calls must be on
 * FORCEFIELD_CONTROL_PLANE_PATHS: Next.js adds x-middleware-subrequest to fetches
 * made from middleware, so without the exemption our own sites' calls are
 * recorded as CVE-2025-29927 attacks against Instinct. That happened on
 * 2026-10-30 when /api/forcefield/site-policy was added without it (a high
 * severity alert for our own policy fetches). The endpoints are derived from the
 * engine's own URL builders, so a new one fails here until it is listed.
 */
import { FORCEFIELD_CONTROL_PLANE_PATHS, detectHeaderAttack } from "@/lib/forcefield-web/enforce";
import { sitePolicyUrl } from "@/lib/forcefield-web/monitor";

const HUB = "https://hub.example";
const env = { FORCEFIELD_INGEST_URL: `${HUB}/api/site-analytics/ingest` } as unknown as NodeJS.ProcessEnv;

describe("Forcefield control-plane endpoints are exempt from the middleware-bypass rule", () => {
  const called = [
    new URL(env.FORCEFIELD_INGEST_URL!).pathname, // events (monitor.ts forwards here)
    "/api/forcefield/ruleset", // FORCEFIELD_RULESET_URL (tenant-quickstart.ts)
    "/api/forcefield/observe", // the Cloudflare Worker / plugin decision
    new URL(sitePolicyUrl("s", env)!).pathname, // the site's agent policy
  ];

  it.each(called)("%s is listed", (path) => {
    expect(FORCEFIELD_CONTROL_PLANE_PATHS.has(path)).toBe(true);
  });

  it.each(called)("a middleware fetch to %s is not an attack", (path) => {
    expect(detectHeaderAttack(["host", "x-middleware-subrequest"], path)).toBeNull();
  });

  it("the header on any other path is still the CVE-2025-29927 attack", () => {
    expect(detectHeaderAttack(["host", "x-middleware-subrequest"], "/admin")).toBe("nextjs_middleware_bypass");
  });
});
