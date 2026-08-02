/**
 * Connection-string normalisation, extracted so the per-tenant pool factory can
 * use it without importing src/lib/db.ts — which imports the pool factory, and
 * would be a cycle.
 *
 * Behaviour is unchanged; db.ts re-exports it so every existing caller and its
 * tests keep working against the same name.
 */
/**
 * Normalize the connection string to explicitly request
 * `sslmode=verify-full`. pg-connection-string v3.0.0 / pg v9.0.0 will
 * change the meaning of `sslmode=require` (and `prefer` / `verify-ca`)
 * to libpq-compatible weaker semantics; the library currently emits
 * a SECURITY WARNING on every boot when those modes are seen. Setting
 * verify-full explicitly preserves today's strict-cert behaviour
 * across the upcoming upgrade and silences the warning.
 *
 * Pure for unit testing; returns undefined when input is undefined so
 * shadow mode keeps working.
 */
export function normalizeDatabaseUrlSsl(
  url: string | undefined,
): string | undefined {
  if (!url) return url;
  /* If sslmode is already verify-full, pass through unchanged. */
  if (/[?&]sslmode=verify-full(\b|&|$)/i.test(url)) return url;
  /* Replace any other sslmode value (require/prefer/verify-ca/disable). */
  if (/[?&]sslmode=[^&]+/i.test(url)) {
    return url.replace(/(?<=[?&])sslmode=[^&]+/i, "sslmode=verify-full");
  }
  /* No sslmode in URL — append. Pick the right separator based on
     whether a query string already exists. */
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}sslmode=verify-full`;
}
