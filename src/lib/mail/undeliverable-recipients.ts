/**
 * mail/undeliverable-recipients.ts — single source of truth for email
 * addresses the system must NEVER attempt to deliver to.
 *
 * Why this exists: `@wolfpack.dev` addresses (cto@, ceo@, dev@, sales@, ops@,
 * accounting@, …) are DEMO / SEED placeholders baked into the product
 * (`src/lib/auth.ts` demo users + seeded `instinct_team_members` rows).
 * `wolfpack.dev` is NOT a Wolfpack-owned domain — it is parked / for-sale on
 * Afternic and publishes a Null MX ("0 .") plus SPF "-all", i.e. it refuses all
 * mail by design. Any real send to it bounces (observed 2026-07-04: 6 DSNs from
 * ppe-hosted.com for cto@wolfpack.dev) AND leaks message subjects/bodies toward
 * a domain a stranger controls.
 *
 * Defense in depth — every outbound path funnels through one of these:
 *   1. `seedEmailExclusionSql()` — WHERE-clause guard that drops seed rows at
 *      recipient selection (the primary, at the DB).
 *   2. `isSeedEmail()` — JS guard that catches any row that slipped the SQL
 *      (e.g. a reseed that re-armed `is_active`), applied on query results.
 *   3. `sendViaGraph()` chokepoint — refuses the send regardless of caller, so
 *      a brand-new send path can never reintroduce the bounce class.
 */

/** Domains that reject all mail (Null MX) and/or that Wolfpack does not own.
 *  Lowercase, no leading "@". Extend here to retire any future placeholder. */
export const UNDELIVERABLE_EMAIL_DOMAINS: readonly string[] = ["wolfpack.dev"];

/** Lowercased domain of `email`, or null when there is no parseable domain. */
function domainOf(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.lastIndexOf("@");
  if (at === -1) return null;
  const domain = email.slice(at + 1).trim().toLowerCase();
  return domain.length > 0 ? domain : null;
}

/** True when `email` belongs to a known-undeliverable seed domain. Null-safe. */
export function isSeedEmail(email: string | null | undefined): boolean {
  const domain = domainOf(email);
  return domain !== null && UNDELIVERABLE_EMAIL_DOMAINS.includes(domain);
}

/** The seed domain of `email` (for analytics metadata), or null if deliverable. */
export function seedEmailDomain(email: string | null | undefined): string | null {
  const domain = domainOf(email);
  return domain !== null && UNDELIVERABLE_EMAIL_DOMAINS.includes(domain)
    ? domain
    : null;
}

/**
 * A SQL boolean predicate that EXCLUDES undeliverable seed recipients, for use
 * in a WHERE clause. `column` is the email column (default "email") — a trusted
 * caller-supplied identifier, never user input. The domain list is a module
 * constant, so the built literal is injection-free.
 *
 *   WHERE is_active = true AND ${seedEmailExclusionSql()}
 *   →  WHERE is_active = true AND (lower(email) NOT LIKE '%@wolfpack.dev')
 */
export function seedEmailExclusionSql(column = "email"): string {
  const clauses = UNDELIVERABLE_EMAIL_DOMAINS.map(
    (d) => `lower(${column}) NOT LIKE '%@${d}'`,
  );
  return `(${clauses.join(" AND ")})`;
}
