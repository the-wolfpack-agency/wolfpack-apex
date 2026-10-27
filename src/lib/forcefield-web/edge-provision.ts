/**
 * Forcefield Edge - attach a hostname to the Edge Vercel project and report the
 * DNS record the owner must create (apex only).
 *
 * Reuses the Sites domain wrapper (src/lib/sites-domain.ts) for every REST call,
 * so the Vercel API shape, error classification and validation live in one
 * place. Credentials are the existing team-scoped pair the Sites module already
 * uses (VERCEL_TOKEN_WOLFPACK_AGENCY + VERCEL_ORG_ID) plus the Edge project id
 * (FORCEFIELD_EDGE_VERCEL_PROJECT_ID). The token is read from env per call and
 * passed only in the Authorization header; it is never logged, never returned,
 * and never part of an error message this module produces.
 *
 * Every function returns a typed result and never throws: a 403/429/5xx from the
 * platform becomes { ok:false, error } that the admin route maps to a status.
 */
import {
  addDomainToProject,
  getDomainStatus,
  getDomainConfig,
  VercelDomainError,
  type VercelDomainErrorCode,
  type VercelDomainRecord,
  type VercelDomainConfig,
} from "@/lib/sites-domain";
import { recordHostnameStatus, type EdgeDnsRecord, type EdgeQuery } from "./edge-sites";

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface EdgeVercelConfig {
  token: string;
  teamId: string;
  projectId: string;
}

/** The Edge project credentials from env, or null when any is missing (the
 *  provisioning action then reports `not_configured` and changes nothing). */
export function edgeVercelConfig(env: Record<string, string | undefined> = process.env): EdgeVercelConfig | null {
  const token = env.VERCEL_TOKEN_WOLFPACK_AGENCY ?? "";
  const teamId = env.VERCEL_ORG_ID ?? "";
  const projectId = env.FORCEFIELD_EDGE_VERCEL_PROJECT_ID ?? "";
  if (!token || !teamId || !projectId) return null;
  return { token, teamId, projectId };
}

/** Fallbacks used only when the platform returns no recommendation. These are
 *  the long-standing generic values in Vercel's custom-domain documentation. */
export const FALLBACK_CNAME_TARGET = "cname.vercel-dns.com";
export const FALLBACK_APEX_IPV4 = "76.76.21.21";

/** The record name relative to its zone: "edge-test" for edge-test.ogiam.com in
 *  zone ogiam.com, "@" for the apex itself. */
export function relativeName(fqdn: string, apex: string): string {
  const f = fqdn.toLowerCase().replace(/\.$/, "");
  const a = apex.toLowerCase().replace(/\.$/, "");
  if (f === a) return "@";
  return f.endsWith(`.${a}`) ? f.slice(0, -(a.length + 1)) : f;
}

/** A best-effort apex when the platform did not name one: the last two labels.
 *  Wrong for multi-label public suffixes (example.co.uk), which is why the
 *  platform's apexName always wins when present. */
function guessApex(hostname: string): string {
  const parts = hostname.split(".");
  return parts.slice(-2).join(".");
}

/**
 * PURE: the DNS records the owner must create for a hostname. One routing
 * record (CNAME for a subdomain, A for an apex, which cannot carry a CNAME), plus
 * any ownership TXT records the platform requires (it asks for those when the
 * domain is already used by another account).
 */
export function dnsRecordsFor(hostname: string, domain: VercelDomainRecord | null, config: VercelDomainConfig | null): EdgeDnsRecord[] {
  const apex = domain?.apexName || guessApex(hostname);
  const name = relativeName(hostname, apex);
  const records: EdgeDnsRecord[] = [];
  if (name === "@") {
    records.push({ type: "A", name: "@", value: config?.recommendedIpv4 || FALLBACK_APEX_IPV4, purpose: "route" });
  } else {
    records.push({ type: "CNAME", name, value: config?.recommendedCname || FALLBACK_CNAME_TARGET, purpose: "route" });
  }
  for (const v of domain?.verification ?? []) {
    if (v.type.toUpperCase() !== "TXT") continue;
    records.push({ type: "TXT", name: relativeName(v.domain || hostname, apex), value: v.value, purpose: "verify" });
  }
  return records;
}

export type EdgeHostnameStatus = {
  ok: true;
  hostname: string;
  /** The platform accepted the hostname for the project (ownership settled). */
  attached: boolean;
  /** DNS points at Edge and a certificate can be issued: traffic flows. */
  live: boolean;
  configuredBy: string | null;
  records: EdgeDnsRecord[];
};

export type EdgeProvisionError = { ok: false; error: "not_configured" | VercelDomainErrorCode; status: number };

function failure(err: unknown): EdgeProvisionError {
  if (err instanceof VercelDomainError) return { ok: false, error: err.code, status: err.status };
  return { ok: false, error: "unknown", status: 0 };
}

async function statusFor(
  cfg: EdgeVercelConfig,
  tenantId: string,
  hostname: string,
  domain: VercelDomainRecord | null,
  fetchImpl: FetchLike | undefined,
  q: EdgeQuery | undefined,
): Promise<EdgeHostnameStatus> {
  // The config read is advisory: if it fails, the record still renders with the
  // documented fallback values and live=false, rather than failing the action.
  const config = await getDomainConfig({ projectId: cfg.projectId, domain: hostname, teamId: cfg.teamId, token: cfg.token, fetchImpl }).catch(() => null);
  const records = dnsRecordsFor(hostname, domain, config);
  const attached = domain?.verified === true;
  const live = attached && config !== null && config.misconfigured === false;
  await (q ? recordHostnameStatus(tenantId, hostname, live, records, q) : recordHostnameStatus(tenantId, hostname, live, records));
  return { ok: true, hostname, attached, live, configuredBy: config?.configuredBy ?? null, records };
}

/**
 * Add a hostname to the Edge project and report what the owner must do next.
 * Idempotent: a hostname already on the Edge project is re-read, not an error.
 */
export async function provisionEdgeHostname(
  tenantId: string,
  hostname: string,
  opts: { fetchImpl?: FetchLike; env?: Record<string, string | undefined>; q?: EdgeQuery } = {},
): Promise<EdgeHostnameStatus | EdgeProvisionError> {
  const cfg = edgeVercelConfig(opts.env);
  if (!cfg) return { ok: false, error: "not_configured", status: 0 };
  let domain: VercelDomainRecord | null;
  try {
    domain = await addDomainToProject({ projectId: cfg.projectId, domain: hostname, teamId: cfg.teamId, token: cfg.token, fetchImpl: opts.fetchImpl });
  } catch (err) {
    // Already on THIS project -> read its state instead. On another project or
    // account, getDomainStatus returns null and the conflict stands.
    if (err instanceof VercelDomainError && err.code === "domain_in_use") {
      try {
        domain = await getDomainStatus({ projectId: cfg.projectId, domain: hostname, teamId: cfg.teamId, token: cfg.token, fetchImpl: opts.fetchImpl });
      } catch (e) {
        return failure(e);
      }
      if (!domain) return failure(err);
    } else {
      return failure(err);
    }
  }
  return statusFor(cfg, tenantId, hostname, domain, opts.fetchImpl, opts.q);
}

/** Re-check a hostname already added (the owner says they created the record). */
export async function checkEdgeHostname(
  tenantId: string,
  hostname: string,
  opts: { fetchImpl?: FetchLike; env?: Record<string, string | undefined>; q?: EdgeQuery } = {},
): Promise<EdgeHostnameStatus | EdgeProvisionError> {
  const cfg = edgeVercelConfig(opts.env);
  if (!cfg) return { ok: false, error: "not_configured", status: 0 };
  try {
    const domain = await getDomainStatus({ projectId: cfg.projectId, domain: hostname, teamId: cfg.teamId, token: cfg.token, fetchImpl: opts.fetchImpl });
    return statusFor(cfg, tenantId, hostname, domain, opts.fetchImpl, opts.q);
  } catch (err) {
    return failure(err);
  }
}
