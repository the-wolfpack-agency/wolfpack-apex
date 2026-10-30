/**
 * Who presented an ingest token: one of our shared site tokens
 * (SITE_ANALYTICS_INGEST_TOKEN / _2, our own properties), a Forcefield tenant's
 * own token (resolved by hash, ACTIVE tenants only), or the Edge service token
 * naming an active tenant. Shared by the event ingest and the per-site policy
 * endpoint so both authenticate a site the same way. Constant-time compares;
 * never throws (an error is "nobody").
 */
import { timingSafeEqual } from "crypto";
import { resolveTenantByToken } from "@/lib/forcefield-web/tenants";
import { resolveActiveTenantById } from "@/lib/forcefield-web/edge-sites";
import { edgeServiceTokenMatches } from "@/lib/forcefield-web/edge-service-token";

export type IngestCaller =
  | { kind: "shared" }
  | { kind: "tenant"; tenant: { id: string; siteLabel: string }; edge: boolean };

/** Constant-time string compare that never throws on length mismatch. */
export function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** The configured shared tokens (any of them authenticates an internal site). */
export function sharedIngestTokens(env: NodeJS.ProcessEnv = process.env): string[] {
  return [env.SITE_ANALYTICS_INGEST_TOKEN, env.SITE_ANALYTICS_INGEST_TOKEN_2].filter((t): t is string => typeof t === "string" && t.length > 0);
}

export async function resolveIngestCaller(provided: string, edgeTenantId: string | null, env: NodeJS.ProcessEnv = process.env): Promise<IngestCaller | null> {
  try {
    if (edgeTenantId && edgeServiceTokenMatches(provided)) {
      const t = await resolveActiveTenantById(edgeTenantId).catch(() => null);
      return t ? { kind: "tenant", tenant: t, edge: true } : null;
    }
    if (provided && sharedIngestTokens(env).some((t) => tokenMatches(provided, t))) return { kind: "shared" };
    if (!provided) return null;
    const t = await resolveTenantByToken(provided);
    return t ? { kind: "tenant", tenant: t, edge: false } : null;
  } catch {
    return null;
  }
}
