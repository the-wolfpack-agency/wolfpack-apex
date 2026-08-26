/**
 * A destructive test must never be able to reach a real database.
 *
 * On 2026-08-26 a *.db.test.ts that does DROP TABLE ... CASCADE was run with
 * TEST_DATABASE_URL pointed at production, because the previous version of the
 * same file only read information_schema and the command line was reused
 * without re-reading what the file now did. It destroyed instinct_ms_tokens:
 * six OAuth tokens, the unique index and the backward-compat view. Recovered
 * from a Neon point-in-time branch, byte-identical, but only because Neon
 * keeps history.
 *
 * NO AMOUNT OF CARE FIXES THIS. The failure was a human reusing a shell command
 * whose meaning had changed underneath it, and that will happen again. The
 * control has to be in the code, refusing, rather than in whoever is typing.
 *
 * So: a db test that builds schema calls this first, and it refuses any host
 * that is not local. Fails closed, because a URL it cannot parse is a URL it
 * cannot vouch for.
 */

/** Hosts a destructive test may touch. Nothing else, ever. */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "postgres", "db"]);

export class UnsafeTestDatabaseError extends Error {}

/**
 * Assert this URL is a throwaway database, or throw.
 *
 * Returns the URL so a caller can write `new Client({ connectionString:
 * requireLocalTestDatabase(URL) })` and cannot forget to check first.
 */
export function requireLocalTestDatabase(url: string | undefined): string {
  if (!url) {
    throw new UnsafeTestDatabaseError(
      "No TEST_DATABASE_URL. A schema-building test needs a throwaway database.",
    );
  }

  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    /* Unparseable means unverifiable. A test that cannot tell where it is
       pointing has no business dropping anything. */
    throw new UnsafeTestDatabaseError(
      "TEST_DATABASE_URL could not be parsed, so it cannot be shown to be local. Refusing.",
    );
  }

  if (!LOCAL_HOSTS.has(host)) {
    throw new UnsafeTestDatabaseError(
      `Refusing to run a schema-building test against "${host}". ` +
        "This suite drops and recreates tables. Point TEST_DATABASE_URL at a " +
        "local throwaway database, never at a hosted one. " +
        "(2026-08-26: this exact mistake destroyed the production token table.)",
    );
  }

  return url;
}
