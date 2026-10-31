/**
 * Which site a canary request is for: a tenant's token pins its own site label;
 * one of our shared site tokens names the site in the body. Shared by the canary
 * mint and check routes (the same rule as the agent-policy endpoint).
 */
import { resolveIngestCaller } from "@/lib/forcefield-web/ingest-auth";
import { EDGE_TENANT_HEADER } from "@/lib/forcefield-web/gateway";

export async function canarySite(headers: Headers, bodySite: unknown): Promise<{ site: string; key: string } | { error: "unauthorized" | "site_required" }> {
  const caller = await resolveIngestCaller(headers.get("x-ingest-token") ?? "", headers.get(EDGE_TENANT_HEADER));
  if (!caller) return { error: "unauthorized" };
  if (caller.kind === "tenant") return { site: caller.tenant.siteLabel, key: `tenant:${caller.tenant.id}` };
  const site = typeof bodySite === "string" ? bodySite : "";
  if (!/^[a-z0-9._-]{1,64}$/.test(site)) return { error: "site_required" };
  return { site, key: `site:${site}` };
}
