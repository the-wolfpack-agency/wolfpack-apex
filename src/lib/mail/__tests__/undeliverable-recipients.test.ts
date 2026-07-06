/**
 * Unit tests for the undeliverable-recipient guard — the single source of truth
 * for email addresses the system must never attempt to deliver to.
 */

import {
  isSeedEmail,
  seedEmailDomain,
  seedEmailExclusionSql,
  UNDELIVERABLE_EMAIL_DOMAINS,
} from "@/lib/mail/undeliverable-recipients";

describe("isSeedEmail", () => {
  it.each([
    "cto@wolfpack.dev",
    "ceo@wolfpack.dev",
    "CTO@Wolfpack.DEV", // case-insensitive
    "  ops@wolfpack.dev  ", // trims stray whitespace
    "a.b+tag@wolfpack.dev", // sub-addressing still on the seed domain
  ])("is true for seed address %s", (email) => {
    expect(isSeedEmail(email)).toBe(true);
  });

  it.each([
    "max@thewolfpack.agency", // the real domain — must NOT match
    "nick@wolfpack.dev.evil.com", // domain is not wolfpack.dev
    "someone@notwolfpack.dev", // suffix trap
    "plainaddress", // no @
    "",
  ])("is false for deliverable / malformed address %s", (email) => {
    expect(isSeedEmail(email)).toBe(false);
  });

  it("is null-safe", () => {
    expect(isSeedEmail(null)).toBe(false);
    expect(isSeedEmail(undefined)).toBe(false);
  });
});

describe("seedEmailDomain", () => {
  it("returns the matched seed domain for analytics metadata", () => {
    expect(seedEmailDomain("cto@wolfpack.dev")).toBe("wolfpack.dev");
    expect(seedEmailDomain("CTO@WOLFPACK.DEV")).toBe("wolfpack.dev");
  });
  it("returns null for deliverable or malformed addresses", () => {
    expect(seedEmailDomain("max@thewolfpack.agency")).toBeNull();
    expect(seedEmailDomain("nope")).toBeNull();
    expect(seedEmailDomain(null)).toBeNull();
  });
});

describe("seedEmailExclusionSql", () => {
  it("builds a NOT-LIKE predicate for every seed domain (default column)", () => {
    const sql = seedEmailExclusionSql();
    for (const domain of UNDELIVERABLE_EMAIL_DOMAINS) {
      expect(sql).toContain(`lower(email) NOT LIKE '%@${domain}'`);
    }
    expect(sql.startsWith("(")).toBe(true);
    expect(sql.endsWith(")")).toBe(true);
  });

  it("honors a custom column name", () => {
    expect(seedEmailExclusionSql("m.email")).toContain(
      "lower(m.email) NOT LIKE '%@wolfpack.dev'",
    );
  });

  it("is injection-free — contains only our constant domains", () => {
    // No user input reaches this fn; assert the literal is exactly what we built.
    expect(seedEmailExclusionSql()).toBe(
      "(" +
        UNDELIVERABLE_EMAIL_DOMAINS.map(
          (d) => `lower(email) NOT LIKE '%@${d}'`,
        ).join(" AND ") +
        ")",
    );
  });
});
