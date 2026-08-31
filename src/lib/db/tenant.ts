/**
 * Which database a request belongs to.
 *
 * Instinct is sold per client, and each client gets their OWN database. The
 * boundary between two companies is therefore the database itself rather than a
 * predicate in a query — which is a much stronger guarantee, because no query
 * bug can cross it.
 *
 * That guarantee rests entirely on this file getting one thing right: the
 * database a request uses must be derived from something the caller cannot
 * choose. Everything below exists to make the unsafe version impossible rather
 * than merely discouraged.
 *
 * THE RULES, AND WHY EACH ONE IS ABSOLUTE
 *
 * 1. FAIL CLOSED. In routed mode, a request with no resolved tenant throws.
 *    There is no default database, no "fall back to DATABASE_URL". A fallback
 *    is the whole vulnerability: it turns every bug that loses the tenant into
 *    a silent read of somebody else's data, and it would do so quietly and
 *    successfully.
 *
 * 2. THE TENANT IS NEVER TAKEN FROM THE REQUEST. Not a subdomain, not a header,
 *    not a body field, not a query parameter. Callers pass a tenant id that
 *    came from the verified session claim, and withTenant() is the only door.
 *    This module cannot enforce where the caller got it, so the guardrail test
 *    enforces it at the route layer instead.
 *
 * 3. STRICT IDS. A tenant id is used to build an environment variable name, so
 *    an unconstrained one is an injection into configuration lookup. The
 *    pattern is narrow and validated before use.
 *
 * 4. INERT UNTIL SWITCHED ON. With INSTINCT_DB_MODE unset the behavior is
 *    exactly today's: one DATABASE_URL, one pool, nothing routed. A migration
 *    this significant should not change production the moment it merges.
 *
 * Pure: no pg, no I/O. Every rule here is a unit test.
 */

export type DbMode = "single" | "routed";

/**
 * Tenant ids are lowercase, short, and used to build an env var name. Anything
 * outside this is refused before it reaches configuration lookup.
 *
 * Two characters minimum (a short client code like "a1" is legitimate), must
 * start with a letter and end alphanumeric, so a leading or trailing dash
 * cannot produce a double underscore in the variable name and collide with a
 * different tenant.
 */
const TENANT_ID = /^[a-z][a-z0-9-]{0,38}[a-z0-9]$/;

export class TenantResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TenantResolutionError";
  }
}

export function dbMode(env: NodeJS.ProcessEnv = process.env): DbMode {
  return env.INSTINCT_DB_MODE === "routed" ? "routed" : "single";
}

export function isValidTenantId(value: unknown): value is string {
  return typeof value === "string" && TENANT_ID.test(value);
}

/** The env var holding a tenant's connection string. */
export function tenantEnvVar(tenantId: string): string {
  return `INSTINCT_TENANT_DB_${tenantId.toUpperCase().replace(/-/g, "_")}`;
}

export interface ResolvedTenant {
  tenantId: string;
  connectionString: string;
}

/**
 * The connection string for one tenant.
 *
 * Throws rather than returning null. A caller that has to remember to check a
 * null is a caller that will eventually forget, and forgetting here means
 * running a query against whatever pool was lying around.
 */
export function resolveTenant(tenantId: string, env: NodeJS.ProcessEnv = process.env): ResolvedTenant {
  if (!isValidTenantId(tenantId)) {
    throw new TenantResolutionError(`invalid tenant id: ${JSON.stringify(String(tenantId).slice(0, 60))}`);
  }
  const varName = tenantEnvVar(tenantId);
  const connectionString = env[varName]?.trim();
  if (!connectionString) {
    // Names the variable, because "unknown tenant" sends someone digging and
    // the variable name is the fix. It does NOT echo any connection string.
    throw new TenantResolutionError(`no database configured for tenant '${tenantId}' (${varName} is not set)`);
  }
  return { tenantId, connectionString };
}

/** Every tenant this deployment can serve, from the environment. Used by the
 *  migration runner to fan out, and by an admin surface to show coverage. */
export function configuredTenants(env: NodeJS.ProcessEnv = process.env): string[] {
  const prefix = "INSTINCT_TENANT_DB_";
  return Object.keys(env)
    .filter((k) => k.startsWith(prefix) && (env[k] ?? "").trim() !== "")
    .map((k) => k.slice(prefix.length).toLowerCase().replace(/_/g, "-"))
    .filter(isValidTenantId)
    .sort();
}

/**
 * The connection string to use, given the tenant the request resolved to.
 *
 * `single` mode ignores the tenant entirely and uses DATABASE_URL, which is
 * today's behavior and stays the default. `routed` mode has no default at all.
 */
export function connectionStringFor(
  tenantId: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (dbMode(env) === "single") return env.DATABASE_URL;

  if (!tenantId) {
    throw new TenantResolutionError(
      "no tenant in scope. In routed mode every database request must run inside withTenant(); there is deliberately no default database to fall back to.",
    );
  }
  return resolveTenant(tenantId, env).connectionString;
}
