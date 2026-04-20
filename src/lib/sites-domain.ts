/**
 * sites-domain.ts — thin Vercel Domains REST wrapper for Instinct Sites.
 *
 * Powers custom-domain binding so a designer can ship real branded URLs
 * (`acme.com`) instead of `wolfpack-{slug}.vercel.app`. This is a direct
 * mirror of `vercel-client.ts` — injectable `fetch`, team-scoped token,
 * typed errors, no new runtime dependencies. Zero data lost: every call
 * returns enough detail that the orchestration layer
 * (`site-domains.ts`) can persist the full verification-record set into
 * `instinct_site_domains` and keep the learning loop honest.
 *
 * Scope is deliberately small — add / status / remove. Anything else
 * (TLS monitoring, redirect rules, wildcard issuance) stays out of this
 * module so tests can mock `fetch` exhaustively.
 *
 * SECURITY NOTE: server-only. The token never leaves the server. Every
 * consumer is the HTTP route under `src/app/api/sites/[id]/domain/`,
 * which runs through `getUserFromRequest` before it reaches this code.
 */
export interface VercelDomainRecord {
  domain: string;
  verified: boolean;
  verification: Array<{
    type: string;
    domain: string;
    value: string;
    reason?: string;
  }>;
  createdAt: number;
}

/** Codes callers map to HTTP status. */
export type VercelDomainErrorCode =
  | "unauthorized"
  | "domain_in_use"
  | "domain_invalid"
  | "rate_limited"
  | "network"
  | "unknown";

export class VercelDomainError extends Error {
  public code: VercelDomainErrorCode;
  public status: number;
  public body: string;
  constructor(code: VercelDomainErrorCode, status: number, body: string) {
    super(`vercel domain ${code} (${status}): ${body.slice(0, 500)}`);
    this.name = "VercelDomainError";
    this.code = code;
    this.status = status;
    this.body = body.slice(0, 500);
  }
}

/**
 * Map a Vercel error status + body to one of our typed codes. Body is
 * inspected for well-known reasons (`domain_already_in_use`,
 * `invalid_domain`) so callers don't have to re-parse Vercel's JSON.
 */
export function classifyVercelError(
  status: number,
  body: string,
): VercelDomainErrorCode {
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 429) return "rate_limited";
  if (status === 400 || status === 422) {
    if (/invalid[_ -]?domain/i.test(body)) return "domain_invalid";
    if (/already[_ -]?in[_ -]?use|domain_already|used_by/i.test(body)) {
      return "domain_in_use";
    }
    return "domain_invalid";
  }
  if (status === 409) return "domain_in_use";
  return "unknown";
}

/**
 * Validate a public domain. Lowercase ASCII letters/digits/dot/hyphen,
 * TLD length ≥2, total length ≤253. Reject bare IPv4, `localhost`, and
 * anything that starts or ends with `.` or `-`.
 *
 * Vercel does its own validation server-side; this check keeps obvious
 * junk from hitting the API (and eating rate limit) and also hardens
 * the DB path where we insert into `instinct_site_domains`.
 */
export function isValidDomain(input: unknown): input is string {
  if (typeof input !== "string") return false;
  const v = input.trim().toLowerCase();
  if (!v || v.length > 253) return false;
  if (v === "localhost") return false;
  // Reject IP-like strings.
  if (/^\d+\.\d+\.\d+\.\d+$/.test(v)) return false;
  // Core shape: one or more labels separated by dots, TLD ≥2 chars.
  //   label: [a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?
  //   tld:   [a-z]{2,63}
  const re =
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
  return re.test(v);
}

const VERCEL_API = "https://api.vercel.com";

function authHeaders(token: string): HeadersInit {
  return {
    "Authorization": `Bearer ${token}`,
    "Content-Type": "application/json",
    "User-Agent": "wolfpack-instinct-domains",
  };
}

function domainEndpoint(
  projectId: string,
  domain: string,
  teamId: string,
  version: "v9" | "v10",
): string {
  const params = new URLSearchParams({ teamId });
  const p = encodeURIComponent(projectId);
  const d = encodeURIComponent(domain);
  return `${VERCEL_API}/${version}/projects/${p}/domains/${d}?${params.toString()}`;
}

function addEndpoint(projectId: string, teamId: string): string {
  const params = new URLSearchParams({ teamId });
  const p = encodeURIComponent(projectId);
  return `${VERCEL_API}/v10/projects/${p}/domains?${params.toString()}`;
}

/**
 * Normalize a raw Vercel domain response into our `VercelDomainRecord`.
 * Vercel has fluctuated between `verification` (array of DNS records)
 * and `verified: false` + no details; we coerce both into a stable shape
 * so the UI can always render a copy-pasteable verification block.
 */
function normalizeRecord(raw: unknown): VercelDomainRecord {
  const r = (raw ?? {}) as {
    name?: string;
    domain?: string;
    verified?: boolean;
    verification?: Array<{
      type?: string;
      domain?: string;
      value?: string;
      reason?: string;
    }>;
    createdAt?: number;
    created?: number;
  };
  const verification = Array.isArray(r.verification)
    ? r.verification
        .filter((v) => v && typeof v.type === "string" && typeof v.value === "string")
        .map((v) => ({
          type: String(v.type),
          domain: String(v.domain ?? r.name ?? r.domain ?? ""),
          value: String(v.value),
          reason: v.reason ? String(v.reason) : undefined,
        }))
    : [];
  return {
    domain: String(r.name ?? r.domain ?? ""),
    verified: !!r.verified,
    verification,
    createdAt: typeof r.createdAt === "number"
      ? r.createdAt
      : typeof r.created === "number"
        ? r.created
        : Date.now(),
  };
}

interface FetchLike {
  (input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

function resolveFetch(injected?: FetchLike): FetchLike {
  return injected ?? (globalThis.fetch as FetchLike);
}

/**
 * POST /v10/projects/{projectId}/domains?teamId=… — attach a custom
 * domain. Returns the `VercelDomainRecord` including pending DNS
 * verification rows that the UI renders in a copy-pasteable block.
 *
 * Idempotency note: Vercel returns 409 `domain_already_in_use` when the
 * same domain is attached to a different project on the same team. Our
 * caller translates that into a 409 at the HTTP layer. Attaching a
 * domain to the SAME project twice is also 409; callers treat that as
 * "no-op, just re-fetch status".
 */
export async function addDomainToProject(opts: {
  projectId: string;
  domain: string;
  teamId: string;
  token: string;
  fetchImpl?: FetchLike;
}): Promise<VercelDomainRecord> {
  if (!isValidDomain(opts.domain)) {
    throw new VercelDomainError(
      "domain_invalid",
      400,
      `domain "${String(opts.domain)}" failed local validation`,
    );
  }
  const f = resolveFetch(opts.fetchImpl);
  let res: Response;
  try {
    res = await f(addEndpoint(opts.projectId, opts.teamId), {
      method: "POST",
      headers: authHeaders(opts.token),
      body: JSON.stringify({ name: opts.domain.trim().toLowerCase() }),
    });
  } catch (err) {
    throw new VercelDomainError(
      "network",
      0,
      (err as Error).message ?? "network error",
    );
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new VercelDomainError(classifyVercelError(res.status, text), res.status, text);
  }
  const raw = await res.json().catch(() => ({}));
  return normalizeRecord(raw);
}

/**
 * GET /v9/projects/{projectId}/domains/{domain}?teamId=… — read the
 * current verification state. Returns null on 404 so callers can
 * treat "domain no longer attached" as a clean delete.
 */
export async function getDomainStatus(opts: {
  projectId: string;
  domain: string;
  teamId: string;
  token: string;
  fetchImpl?: FetchLike;
}): Promise<VercelDomainRecord | null> {
  if (!isValidDomain(opts.domain)) {
    throw new VercelDomainError(
      "domain_invalid",
      400,
      `domain "${String(opts.domain)}" failed local validation`,
    );
  }
  const f = resolveFetch(opts.fetchImpl);
  let res: Response;
  try {
    res = await f(
      domainEndpoint(opts.projectId, opts.domain.trim().toLowerCase(), opts.teamId, "v9"),
      { method: "GET", headers: authHeaders(opts.token) },
    );
  } catch (err) {
    throw new VercelDomainError(
      "network",
      0,
      (err as Error).message ?? "network error",
    );
  }
  if (res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new VercelDomainError(classifyVercelError(res.status, text), res.status, text);
  }
  const raw = await res.json().catch(() => ({}));
  return normalizeRecord(raw);
}

/**
 * DELETE /v9/projects/{projectId}/domains/{domain}?teamId=… — detach.
 * Idempotent: a 404 returns `{ success: true }` because the end-state
 * matches "domain is no longer attached".
 */
export async function removeDomainFromProject(opts: {
  projectId: string;
  domain: string;
  teamId: string;
  token: string;
  fetchImpl?: FetchLike;
}): Promise<{ success: boolean }> {
  if (!isValidDomain(opts.domain)) {
    throw new VercelDomainError(
      "domain_invalid",
      400,
      `domain "${String(opts.domain)}" failed local validation`,
    );
  }
  const f = resolveFetch(opts.fetchImpl);
  let res: Response;
  try {
    res = await f(
      domainEndpoint(opts.projectId, opts.domain.trim().toLowerCase(), opts.teamId, "v9"),
      { method: "DELETE", headers: authHeaders(opts.token) },
    );
  } catch (err) {
    throw new VercelDomainError(
      "network",
      0,
      (err as Error).message ?? "network error",
    );
  }
  if (res.status === 404) return { success: true };
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new VercelDomainError(classifyVercelError(res.status, text), res.status, text);
  }
  return { success: true };
}

/**
 * Map `VercelDomainErrorCode` → HTTP status the consuming API route
 * should return. Centralised so routes don't drift from the mapping.
 */
export function httpStatusForCode(code: VercelDomainErrorCode): number {
  switch (code) {
    case "unauthorized": return 502;
    case "domain_in_use": return 409;
    case "domain_invalid": return 400;
    case "rate_limited": return 429;
    case "network": return 502;
    case "unknown":
    default: return 502;
  }
}
