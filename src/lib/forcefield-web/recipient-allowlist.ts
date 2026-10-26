/**
 * The Forcefield RECIPIENT ALLOWLIST: the single switch that decides who a
 * Forcefield message may reach.
 *
 * BUILD PHASE (today): Forcefield must not message anyone outside Wolfpack. An
 * address is deliverable only when its domain is on this list, and the list
 * defaults to Wolfpack-owned mail domains. Every tenant-facing delivery path
 * (the onboarding confirmation, the first-evidence email, a tenant's immediate
 * alerts and daily digest) goes through sendForcefieldTenantMail
 * (tenant-mail.ts), which refuses a non-allowlisted address. The self-serve
 * signup also only starts the self-serve flow for an allowlisted address; any
 * other address lands in the operator-reviewed request queue and is sent nothing.
 *
 * OPENING TO CLIENTS LATER is one setting, not a rebuild: the operator sets
 *   FORCEFIELD_RECIPIENT_DOMAINS=*
 * in the Wolfpack Instinct Vercel project (Production), then redeploys. A
 * comma-separated list (e.g. "thewolfpack.agency,pilot-client.com") opens it to
 * exactly those domains instead. Unset, empty or unparseable means the Wolfpack
 * default. The guard test (forcefield-alert-delivery-guardrail.test.ts) fails the
 * build if any delivery path can send to an address this list refuses.
 *
 * Pure and deterministic: no IO, no model client.
 */

/** Wolfpack-owned mail domains (the deliverable one; wolfpack.dev is a parked
 *  Null MX seed domain and is never a recipient). */
export const WOLFPACK_RECIPIENT_DOMAINS: readonly string[] = ["thewolfpack.agency"];

/** The env var the operator changes to open delivery. */
export const RECIPIENT_DOMAINS_ENV = "FORCEFIELD_RECIPIENT_DOMAINS";

/** The value that opens delivery to every domain (the end of the build phase). */
export const OPEN_TO_ALL = "*";

const DOMAIN_RE = /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const EMAIL_RE = /^[^\s@]+@([^\s@]+)$/;

/** The configured allowlist: lowercased domains, or ["*"] when open. */
export function recipientDomains(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = String(env[RECIPIENT_DOMAINS_ENV] ?? "").trim().toLowerCase();
  if (!raw) return [...WOLFPACK_RECIPIENT_DOMAINS];
  const parts = raw.split(",").map((d) => d.trim()).filter(Boolean);
  if (parts.includes(OPEN_TO_ALL)) return [OPEN_TO_ALL];
  const valid = parts.filter((d) => DOMAIN_RE.test(d));
  return valid.length > 0 ? valid : [...WOLFPACK_RECIPIENT_DOMAINS];
}

/** True while Forcefield may only message Wolfpack-domain addresses. */
export function isBuildPhase(env: NodeJS.ProcessEnv = process.env): boolean {
  return !recipientDomains(env).includes(OPEN_TO_ALL);
}

/** The domain of a well-formed address (lowercased), or null. */
export function emailDomain(email: string): string | null {
  const m = EMAIL_RE.exec(String(email ?? "").trim().toLowerCase());
  if (!m) return null;
  const domain = m[1];
  return DOMAIN_RE.test(domain) ? domain : null;
}

/**
 * May a Forcefield message go to this address? EXACT domain match only: a
 * subdomain ("a@x.thewolfpack.agency") or a look-alike suffix
 * ("a@thewolfpack.agency.evil.com") is refused. A malformed address is refused
 * even when delivery is open.
 */
export function isRecipientAllowed(email: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const domain = emailDomain(email);
  if (!domain) return false;
  const allowed = recipientDomains(env);
  if (allowed.includes(OPEN_TO_ALL)) return true;
  return allowed.includes(domain);
}
