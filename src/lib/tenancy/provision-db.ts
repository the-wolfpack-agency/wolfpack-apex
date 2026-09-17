/**
 * Database provider abstraction for OGIAM DB-per-tenant provisioning.
 *
 * Two implementations, chosen by env so live cloud provisioning is DARK until an
 * operator deliberately enables it (the same "build dark, flip on purpose"
 * posture the platform uses everywhere, and it honors the rule against standing
 * up infrastructure without an explicit decision + credential):
 *
 *   manual  (default)  create() returns { pending: true } - no cloud call. The
 *                      tenant is left pending_provision; an operator attaches a
 *                      database (setTenantConnection) out of band.
 *   neon    create() calls the Neon API to create a project/database and returns
 *                      its connection string. Active ONLY when OGIAM_DB_PROVIDER=neon
 *                      AND NEON_API_KEY is set. Never runs otherwise.
 *
 * Ported from wolfpack-ford (DRY); env prefix is OGIAM_ here.
 */
export interface ProvisionOutcome {
  pending: boolean;
  connectionString?: string | null;
  error?: string;
}
export interface DatabaseProvider {
  id: string;
  create(tenantId: string, orgName: string): Promise<ProvisionOutcome>;
}

const manualProvider: DatabaseProvider = {
  id: "manual",
  async create() {
    return { pending: true };
  },
};

const neonProvider: DatabaseProvider = {
  id: "neon",
  async create(tenantId: string) {
    const key = process.env.NEON_API_KEY;
    if (!key) return { pending: true, error: "NEON_API_KEY not set" };
    try {
      // Create a dedicated Neon project for the tenant; its owner connection URI
      // is returned by the API. Only reached when explicitly enabled.
      const res = await fetch("https://console.neon.tech/api/v2/projects", {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ project: { name: `ogiam-${tenantId}` } }),
      });
      if (!res.ok) return { pending: true, error: `neon ${res.status}` };
      const j = (await res.json()) as { connection_uris?: Array<{ connection_uri?: string }> };
      const uri = j.connection_uris?.[0]?.connection_uri;
      return uri ? { pending: false, connectionString: uri } : { pending: true, error: "no connection uri" };
    } catch (e) {
      return { pending: true, error: e instanceof Error ? e.message : "neon_error" };
    }
  },
};

/** The active provider, from env. Defaults to manual (no cloud calls). */
export function activeProvider(env: NodeJS.ProcessEnv = process.env): DatabaseProvider {
  return env.OGIAM_DB_PROVIDER === "neon" ? neonProvider : manualProvider;
}

/** Is live cloud provisioning enabled on this deployment? */
export function provisioningEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OGIAM_DB_PROVIDER === "neon" && Boolean(env.NEON_API_KEY);
}
