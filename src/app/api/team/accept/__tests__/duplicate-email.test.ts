import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isDuplicateEmailError } from "../route";

/**
 * The invite-acceptance outage of 2026-08-03.
 *
 * Every new invitee saw "An account already exists for this email." and could
 * not create an account. A client was turned away by it.
 *
 * TWO FAULTS, AND EITHER ALONE WOULD HAVE BEEN SURVIVABLE.
 *
 * 1. The upsert said `ON CONFLICT ON CONSTRAINT
 *    uq_instinct_team_members_email_lower`. That is a unique INDEX on an
 *    expression (migration 128), and Postgres only permits a table CONSTRAINT
 *    on plain columns, so it can never be one. Every accept raised
 *    `constraint "..." does not exist` whether or not a row collided.
 *
 * 2. The duplicate-email fallback matched on the index NAME, and Postgres puts
 *    that name in the "does not exist" message too. So a broken statement was
 *    reported to the user as an existing account.
 *
 * The second is what made it invisible: the route failed loudly and the UI said
 * something reassuring and wrong.
 */

describe("a broken statement is never reported as an existing account", () => {
  it("treats a real duplicate as a duplicate", () => {
    expect(
      isDuplicateEmailError(
        'duplicate key value violates unique constraint "uq_instinct_team_members_email_lower"',
      ),
    ).toBe(true);
  });

  it("does NOT treat a missing constraint as a duplicate", () => {
    // The exact message production produced, verified against Postgres.
    expect(
      isDuplicateEmailError(
        'constraint "uq_instinct_team_members_email_lower" for table "instinct_team_members" does not exist',
      ),
    ).toBe(false);
  });

  it("does not match merely because the index is named", () => {
    expect(isDuplicateEmailError("relation uq_instinct_team_members_email_lower is invalid")).toBe(false);
  });

  it("says no to an unrelated failure", () => {
    expect(isDuplicateEmailError("could not connect to server")).toBe(false);
  });
});

describe("the upsert targets the index, not a constraint", () => {
  it("uses the expression form", () => {
    // A static guard, because the failing form is valid TypeScript and only
    // fails at the database. Reverting it would restore the outage silently.
    const sql = readFileSync(join(__dirname, "..", "route.ts"), "utf8");
    expect(sql).toContain("ON CONFLICT (LOWER(email))");
    expect(sql).not.toMatch(/ON CONFLICT ON CONSTRAINT\s+uq_instinct_team_members_email_lower/);
  });
});
