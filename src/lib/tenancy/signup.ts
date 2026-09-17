/**
 * Self-serve signup: the "buy -> tenant exists" front door for OGIAM hosted
 * DB-per-tenant. Validates, allocates a tenant id, records the tenant, and asks
 * the active database provider to create the tenant's database.
 *
 * When a provider is enabled and returns a connection string, the tenant is
 * stored + marked active (bootstrapping the org + first admin IN that database is
 * the operator's enable step, run through the migration runner against the new
 * URL). When no provider is enabled (default), the tenant is left
 * pending_provision - honoring the DB-per-tenant model: a new client is NEVER
 * mixed into another tenant's data.
 *
 * Ported from wolfpack-ford (DRY).
 */
import { registerTenant, setTenantConnection, tenantIdFor, getTenant } from "@/lib/tenancy/registry";
import { activeProvider, provisioningEnabled } from "@/lib/tenancy/provision-db";

export interface SignupInput {
  orgName: string;
  adminEmail: string;
}
export interface SignupResult {
  ok: boolean;
  tenantId?: string;
  status?: string;
  provisioningEnabled: boolean;
  error?: string;
  message: string;
}

/**
 * Linear email check (no backtracking-ambiguous regex, so no ReDoS surface -
 * the code gate flagged the original `/^[^@\s]+@[^@\s]+\.[^@\s]+$/` as polynomial
 * on hostile input). Bounds length, requires exactly one non-leading '@', a
 * whitespace-free string, and a dotted domain that does not start or end with a
 * dot. Not an RFC validator, and it does not need to be: it rejects the obvious
 * garbage before we allocate a tenant, and delivery is what proves an address.
 */
function isValidEmail(s: string): boolean {
  if (!s || s.length > 320) return false;
  if (/\s/.test(s)) return false; // single char class, no quantifier: linear
  const at = s.indexOf("@");
  if (at <= 0 || at !== s.lastIndexOf("@")) return false; // exactly one, not leading
  const domain = s.slice(at + 1);
  const dot = domain.lastIndexOf(".");
  return dot > 0 && dot < domain.length - 1; // has a dot, not first/last char
}

export async function signupTenant(input: SignupInput): Promise<SignupResult> {
  const orgName = (input.orgName ?? "").trim();
  const adminEmail = (input.adminEmail ?? "").trim().toLowerCase();
  if (orgName.length < 2) {
    return { ok: false, provisioningEnabled: provisioningEnabled(), error: "org_name", message: "Enter your organization name." };
  }
  if (!isValidEmail(adminEmail)) {
    return { ok: false, provisioningEnabled: provisioningEnabled(), error: "admin_email", message: "Enter a valid admin email." };
  }

  const tenantId = tenantIdFor(orgName);
  if (await getTenant(tenantId)) {
    return { ok: false, tenantId, provisioningEnabled: provisioningEnabled(), error: "exists", message: "An organization with a similar name is already registered." };
  }

  const registered = await registerTenant({ tenantId, orgName, adminEmail });
  if (!registered) {
    return { ok: false, provisioningEnabled: provisioningEnabled(), error: "register", message: "Could not register the organization. Try again." };
  }

  const outcome = await activeProvider().create(tenantId, orgName);
  if (!outcome.pending && outcome.connectionString) {
    await setTenantConnection(tenantId, outcome.connectionString);
    return { ok: true, tenantId, status: "active", provisioningEnabled: true, message: "Your organization is provisioned. Finish setup on the Connections page." };
  }
  return {
    ok: true,
    tenantId,
    status: "pending_provision",
    provisioningEnabled: provisioningEnabled(),
    message: provisioningEnabled()
      ? "Your organization is registered; its database is being prepared. You will be able to sign in shortly."
      : "Your organization is registered and queued for provisioning. We will finish setup and email you the sign-in link.",
  };
}
