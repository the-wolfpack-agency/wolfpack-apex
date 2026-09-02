/** @jest-environment node */
/**
 * A refreshed token that was never stored.
 *
 * WHAT HAPPENED. storeTokens upserts with ON CONFLICT (connected_by).
 * Postgres requires a UNIQUE index on that column to match the specification,
 * and production had a plain one, so every write raised 42P10. The function
 * swallowed it and returned void, and the caller emitted
 * microsoft.token_refreshed on the next line regardless.
 *
 * Measured 2026-09-02: 2,592 refresh events in twenty-four hours against six
 * accounts, roughly eighteen times the healthy rate because nothing was ever
 * saved and every call refreshed again, while the newest stored token sat
 * expired at 2026-08-26.
 *
 * WHY NOBODY SAW IT. Interactive requests kept working: each one refreshed in
 * memory and used that. Only code reading a STORED token noticed, and that is
 * all background work, which fails quietly by nature. The SharePoint sync
 * stopped on 2026-08-27 and the library repair failed every run with no_token,
 * and neither said why.
 *
 * The shape of the defect is the one that keeps recurring here: an event named
 * for an outcome, fired on an attempt. These tests pin the two halves of the
 * fix, so a write that fails is reported as a failure and is never announced
 * as a success.
 */

const mockQuery = jest.fn();
const mockTrack = jest.fn();

jest.mock("@/lib/db", () => ({ query: (...a: unknown[]) => mockQuery(...a) }));
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: unknown[]) => mockTrack(...a) }));

import { storeTokens } from "@/lib/microsoft-graph";

const TOKENS = {
  access_token: "at",
  refresh_token: "rt",
  expires_at: new Date(Date.now() + 3_600_000).toISOString(),
  user_email: "someone@example.test",
} as never;

/** The exact error Postgres raises when the conflict target has no unique index. */
function conflictTargetMissing(): Error & { code: string } {
  const e = new Error(
    "there is no unique or exclusion constraint matching the ON CONFLICT specification",
  ) as Error & { code: string };
  e.code = "42P10";
  return e;
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.DATABASE_URL = "postgres://test";
});

describe("storeTokens says whether it stored anything", () => {
  it("returns true when the row is written", async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await expect(storeTokens(TOKENS, "u1", "someone@example.test")).resolves.toBe(true);
  });

  /* THE CASE THAT RAN IN PRODUCTION. Returning void here is what let the
     caller announce a refresh that had not been kept. */
  it("returns false when the upsert has no unique index to conflict on", async () => {
    mockQuery.mockRejectedValue(conflictTargetMissing());
    await expect(storeTokens(TOKENS, "u1", "someone@example.test")).resolves.toBe(false);
  });

  it("reports the failure with its SQLSTATE, rather than only logging it", async () => {
    mockQuery.mockRejectedValue(conflictTargetMissing());
    await storeTokens(TOKENS, "u1", "someone@example.test");
    expect(mockTrack).toHaveBeenCalledWith(
      "microsoft.token_store_failed",
      "u1",
      "system",
      expect.objectContaining({ code: "42P10" }),
    );
  });

  /* A console line in a serverless function is read by nobody. The whole
     reason this went a week unnoticed is that the only trace was one. */
  it("does not swallow the failure silently", async () => {
    mockQuery.mockRejectedValue(conflictTargetMissing());
    await storeTokens(TOKENS, "u1", "someone@example.test");
    expect(mockTrack).toHaveBeenCalled();
  });

  /* Any DB failure, not only this one. A dropped connection loses the token
     just as completely and must read the same way. */
  it("treats an ordinary database error as not stored", async () => {
    mockQuery.mockRejectedValue(new Error("connection terminated unexpectedly"));
    await expect(storeTokens(TOKENS, "u1", "someone@example.test")).resolves.toBe(false);
  });

  /* Without a database there is nowhere to keep it, which is not the same as
     having kept it. */
  it("returns false when there is no database configured", async () => {
    delete process.env.DATABASE_URL;
    await expect(storeTokens(TOKENS, "u1", "someone@example.test")).resolves.toBe(false);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("names connected_by as the conflict target it depends on", async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await storeTokens(TOKENS, "u1", "someone@example.test");
    expect(String(mockQuery.mock.calls[0][0])).toMatch(/ON CONFLICT \(connected_by\)/);
  });
});

/**
 * A caller who arrives with an email, which the repair does.
 *
 * getValidToken matches `connected_by = $1 OR user_email = $1`, so an address
 * is a legitimate lookup key. Writing the refreshed token back under that same
 * key would put an email into connected_by and attempt a second row for one
 * mailbox, which the unique index on user_email refuses. The refresh would
 * then fail for exactly the background job that needed it, which is the job
 * that was already failing with no_token.
 */
describe("the key a refreshed token is stored under", () => {
  it("uses the row's connected_by, not the lookup key", async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await storeTokens(TOKENS, "165139f0-6c15-4f9d-bc67-063cb22017db", "someone@example.test");
    const params = mockQuery.mock.calls[0][1] as unknown[];
    expect(params[params.length - 1]).toBe("165139f0-6c15-4f9d-bc67-063cb22017db");
  });

  /* A duplicate mailbox is refused by the unique index on user_email, and that
     refusal must be reported rather than swallowed, or the background job goes
     back to failing for a reason nothing states. */
  it("reports a unique-violation as not stored", async () => {
    const dup = new Error("duplicate key value violates unique constraint") as Error & { code: string };
    dup.code = "23505";
    mockQuery.mockRejectedValue(dup);
    await expect(storeTokens(TOKENS, "u1", "someone@example.test")).resolves.toBe(false);
    expect(mockTrack).toHaveBeenCalledWith(
      "microsoft.token_store_failed",
      "u1",
      "system",
      expect.objectContaining({ code: "23505" }),
    );
  });
});
