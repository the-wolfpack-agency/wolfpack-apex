/**
 * The client dashboard's sign-in credential when the owner never handled a site
 * key: the WordPress plugin path, where the plugin holds the key and the owner
 * signs in by clicking the link in the confirmation email.
 *
 * A dashboard session is a signed JWT (crypto registry, purpose ff_dashboard,
 * 30 days) that carries only the tenant id. It reads the tenant's own numbers
 * and manages its alert address, exactly what the ingest token allows on the
 * dashboard routes, and nothing else: it is never accepted by the ingest
 * (/api/forcefield/observe), and a disabled tenant stops resolving at once.
 *
 * resolveTenantCredential is the one resolver the dashboard routes use: an
 * ingest token (ff_...) by its hash, or a dashboard session by its signature.
 */
import { signToken, verifyToken } from "@/lib/crypto/sign";
import { getActiveTenantById, resolveTenantByToken, type ForcefieldTenant } from "@/lib/forcefield-web/tenants";

export const DASHBOARD_SESSION_TTL_DAYS = 30;
const PURPOSE = "ff_dashboard";

export function mintDashboardSession(tenantId: string): string {
  return signToken({ p: PURPOSE, t: tenantId }, { ttlSeconds: DASHBOARD_SESSION_TTL_DAYS * 86400 });
}

/** The tenant id in a valid, unexpired dashboard session, or null. */
export function readDashboardSession(token: string): string | null {
  const t = String(token ?? "").trim();
  if (!t || t.length > 2048 || t.startsWith("ff_")) return null;
  const v = verifyToken<{ p?: string; t?: string }>(t);
  if (!v.valid || v.payload.p !== PURPOSE || typeof v.payload.t !== "string") return null;
  return v.payload.t;
}

export interface ResolvedCredential {
  tenant: ForcefieldTenant;
  /** "ingest": the site key itself. "session": a signed dashboard session. */
  via: "ingest" | "session";
}

export interface CredentialDeps {
  byToken?: typeof resolveTenantByToken;
  byId?: typeof getActiveTenantById;
}

/** Resolve the dashboard credential in x-forcefield-token. Never throws. */
export async function resolveTenantCredential(token: string, deps: CredentialDeps = {}): Promise<ResolvedCredential | null> {
  const t = String(token ?? "").trim();
  if (!t) return null;
  try {
    if (t.startsWith("ff_")) {
      const tenant = await (deps.byToken ?? resolveTenantByToken)(t);
      return tenant ? { tenant, via: "ingest" } : null;
    }
    const id = readDashboardSession(t);
    if (!id) return null;
    const tenant = await (deps.byId ?? getActiveTenantById)(id);
    return tenant ? { tenant, via: "session" } : null;
  } catch {
    return null;
  }
}
