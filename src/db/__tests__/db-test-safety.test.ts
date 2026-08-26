/**
 * Every schema-building database test refuses a non-local host.
 *
 * On 2026-08-26 a *.db.test.ts that does DROP TABLE ... CASCADE was run with
 * TEST_DATABASE_URL pointed at production. It destroyed instinct_ms_tokens:
 * six OAuth tokens, the unique index, and the backward-compat view. Recovered
 * byte-identical from a Neon point-in-time branch, but only because Neon keeps
 * history. A database without that would have meant six people reconnecting
 * and no way to prove nothing else was lost.
 *
 * THE MISTAKE WILL BE MADE AGAIN. It was a shell command reused after the file
 * it ran had changed meaning, which is not a lapse anybody trains out of
 * themselves. So the refusal belongs in the code, and this test is what keeps
 * it there for tests nobody has written yet.
 */
import fs from "node:fs";
import path from "node:path";
import { requireLocalTestDatabase, UnsafeTestDatabaseError } from "./db-test-safety";

const DB_TESTS = path.resolve(__dirname);

/** Statements that change or destroy schema rather than reading it. */
const DESTRUCTIVE = /\b(DROP\s+(TABLE|VIEW|INDEX|SCHEMA)|CREATE\s+TABLE|TRUNCATE|ALTER\s+TABLE)\b/i;

function dbTestFiles(): string[] {
  return fs
    .readdirSync(DB_TESTS)
    .filter((f) => f.endsWith(".db.test.ts"))
    .map((f) => path.join(DB_TESTS, f));
}

describe("the guard itself", () => {
  it("allows a local throwaway database", () => {
    expect(requireLocalTestDatabase("postgresql://postgres:postgres@localhost:5432/x")).toContain(
      "localhost",
    );
    expect(() =>
      requireLocalTestDatabase("postgresql://u:p@127.0.0.1:5432/x"),
    ).not.toThrow();
  });

  /* The exact URL shape that caused the incident. */
  it("refuses a hosted database", () => {
    expect(() =>
      requireLocalTestDatabase(
        "postgresql://u:p@ep-spring-mountain-a4dq5jgr-pooler.us-east-1.aws.neon.tech/neondb",
      ),
    ).toThrow(UnsafeTestDatabaseError);
  });

  /* Unparseable means unverifiable, and a test that cannot tell where it is
     pointing has no business dropping anything. */
  it("refuses a URL it cannot parse rather than assuming it is fine", () => {
    expect(() => requireLocalTestDatabase("not-a-url")).toThrow(UnsafeTestDatabaseError);
  });

  it("refuses an absent URL", () => {
    expect(() => requireLocalTestDatabase(undefined)).toThrow(UnsafeTestDatabaseError);
  });
});

describe("every destructive db test is guarded", () => {
  /* THE CLASS, NOT THE INSTANCE. A future db test that drops a table and
     connects with a raw URL is the same incident again, written by somebody
     who never read any of this. */
  it("calls requireLocalTestDatabase before connecting", () => {
    const unguarded = dbTestFiles()
      .filter((f) => {
        const src = fs.readFileSync(f, "utf-8");
        return DESTRUCTIVE.test(src) && !src.includes("requireLocalTestDatabase");
      })
      .map((f) => path.basename(f));

    expect(unguarded).toEqual([]);
  });

  /* Proves the check above can actually see anything: if the glob or the
     directory ever moves, an empty list would pass while asserting nothing. */
  it("found database tests to check", () => {
    expect(dbTestFiles().length).toBeGreaterThan(0);
  });
});
