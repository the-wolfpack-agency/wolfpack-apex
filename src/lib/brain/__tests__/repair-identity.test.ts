/**
 * Whose access the scheduled repair borrows, and what it does with none.
 *
 * THE GAP. The repair runs as `{ id: "cron" }` on the scheduled path, which is
 * correct for the audit row and useless for Graph: "cron" has never completed
 * an OAuth flow, so getValidToken returns null and every document fails with
 * no_token. Every scheduled run this job has ever made was structurally
 * guaranteed to fail, and reconnecting Microsoft would not have changed it.
 *
 * That is the part worth pinning. "re-fetch failed: no_token" reads like a
 * lapsed session, so the error sent us to the wrong place for weeks.
 */

const mockQuery = jest.fn();
jest.mock("@/lib/db", () => ({ query: (...a: unknown[]) => mockQuery(...a) }));

import { findRepairIdentity, NO_IDENTITY_MESSAGE } from "@/lib/brain/repair-identity";

beforeEach(() => mockQuery.mockReset());

describe("finding an account to repair as", () => {
  it("takes the most recently connected one", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ user_email: "nick@thewolfpack.agency", expires_at: "2026-08-26T21:40:58Z" }],
    });
    const id = await findRepairIdentity();
    expect(id?.userEmail).toBe("nick@thewolfpack.agency");

    const [sql] = mockQuery.mock.calls[0];
    /* Ordered by expiry so the freshest is chosen, and it must carry a refresh
       token or there is nothing to renew with when the access token lapses. */
    expect(String(sql)).toMatch(/ORDER BY expires_at DESC/i);
    expect(String(sql)).toMatch(/refresh_token IS NOT NULL/i);
  });

  /* AN EXPIRED ACCESS TOKEN IS NOT A DISQUALIFIER. getValidToken renews from
     the refresh token, so an account that lapsed last week is still the right
     one to borrow. Filtering on expiry here would refuse every account in the
     table and reproduce the bug at a different line. */
  it("does not reject an account whose access token has expired", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ user_email: "nick@thewolfpack.agency", expires_at: "2020-01-01T00:00:00Z" }],
    });
    expect(await findRepairIdentity()).not.toBeNull();
  });

  /* Null is a real answer: nobody has connected Microsoft, and no amount of
     retrying resolves that. */
  it("returns nothing when no account is connected", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    expect(await findRepairIdentity()).toBeNull();
  });

  it("returns nothing rather than throwing when the table cannot be read", async () => {
    mockQuery.mockRejectedValueOnce(new Error("relation does not exist"));
    expect(await findRepairIdentity()).toBeNull();
  });

  /* The message is what somebody acts on, so it has to name the action rather
     than the symptom. "no_token" sent people looking at sessions. */
  it("says what to do about it", () => {
    expect(NO_IDENTITY_MESSAGE).toMatch(/connect microsoft/i);
    expect(NO_IDENTITY_MESSAGE).not.toMatch(/no_token/);
  });
});
