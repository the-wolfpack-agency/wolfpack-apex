/**
 * normalizeDatabaseUrlSsl — guards against the pg / pg-connection-string
 * upcoming SECURITY WARNING for sslmode=require|prefer|verify-ca.
 * The function rewrites the URL to sslmode=verify-full so the warning
 * never fires + the strict-cert behaviour is preserved across the lib
 * upgrade.
 */

import { normalizeDatabaseUrlSsl } from "@/lib/db";

describe("normalizeDatabaseUrlSsl", () => {
  test("undefined passes through (shadow mode)", () => {
    expect(normalizeDatabaseUrlSsl(undefined)).toBeUndefined();
  });

  test("already verify-full → unchanged", () => {
    const url = "postgresql://u:p@h/db?sslmode=verify-full";
    expect(normalizeDatabaseUrlSsl(url)).toBe(url);
  });

  test("sslmode=require → rewritten to verify-full", () => {
    expect(
      normalizeDatabaseUrlSsl("postgresql://u:p@h/db?sslmode=require"),
    ).toBe("postgresql://u:p@h/db?sslmode=verify-full");
  });

  test("sslmode=prefer → rewritten to verify-full", () => {
    expect(
      normalizeDatabaseUrlSsl("postgresql://u:p@h/db?sslmode=prefer"),
    ).toBe("postgresql://u:p@h/db?sslmode=verify-full");
  });

  test("sslmode=verify-ca → rewritten to verify-full", () => {
    expect(
      normalizeDatabaseUrlSsl("postgresql://u:p@h/db?sslmode=verify-ca"),
    ).toBe("postgresql://u:p@h/db?sslmode=verify-full");
  });

  test("no sslmode + no other query string → appends with ?", () => {
    expect(normalizeDatabaseUrlSsl("postgresql://u:p@h/db")).toBe(
      "postgresql://u:p@h/db?sslmode=verify-full",
    );
  });

  test("no sslmode + existing query string → appends with &", () => {
    expect(
      normalizeDatabaseUrlSsl("postgresql://u:p@h/db?application_name=instinct"),
    ).toBe(
      "postgresql://u:p@h/db?application_name=instinct&sslmode=verify-full",
    );
  });

  test("sslmode rewritten in the middle of the query string preserves other params", () => {
    expect(
      normalizeDatabaseUrlSsl(
        "postgresql://u:p@h/db?sslmode=require&application_name=instinct",
      ),
    ).toBe(
      "postgresql://u:p@h/db?sslmode=verify-full&application_name=instinct",
    );
  });
});
