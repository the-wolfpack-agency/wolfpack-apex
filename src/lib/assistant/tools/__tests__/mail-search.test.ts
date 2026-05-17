 
const mockFindThreads = jest.fn();
jest.mock("@/lib/meetings/email-matcher", () => ({
  findThreadsInvolvingAttendees: (...a: any[]) => mockFindThreads(...a),
}));

import { runMailSearch } from "@/lib/assistant/tools/mail-search";

beforeEach(() => {
  mockFindThreads.mockReset();
});

describe("runMailSearch", () => {
  test("returns null when no from/topic slot is given", async () => {
    expect(await runMailSearch({ userId: "u1" })).toBeNull();
  });

  test("passes the 'from' person into the email matcher with a widened pool", async () => {
    mockFindThreads.mockResolvedValue([
      {
        id: "m1",
        subject: "Q2 Retainer",
        from: "James",
        fromEmail: "james@x.co",
        receivedDateTime: "2026-04-01T10:00:00Z",
        bodyPreview: "Looking forward to the Q2 retainer kickoff.",
        isRead: false,
        importance: "normal",
      },
    ]);
    const out = await runMailSearch({ userId: "u1", from: "James" });
    /* When `from` is set we pull a wider pool than `limit` so the
     * sender-side filter below has room to keep `limit` rows. */
    expect(mockFindThreads).toHaveBeenCalledWith("u1", ["James"], [], 20);
    expect(out?.matches[0].subject).toBe("Q2 Retainer");
  });

  /* Regression: 2026-05-17. "find emails from Max" returned threads
   * where Max was just a TO/CC recipient (e.g. "Re: Lincoln Tech
   * Website" from Nick Hoxsie). The upstream matcher hits sender +
   * recipients; we now post-filter to keep only rows where the SENDER
   * matches the needle. */
  test("strictly filters to sender-side matches (drops recipient-only hits)", async () => {
    mockFindThreads.mockResolvedValue([
      {
        id: "m1",
        subject: "Re: Lincoln Tech Website",
        from: "Nick Hoxsie",
        fromEmail: "hoxsie@thewolfpack.agency",
        receivedDateTime: "2026-05-15T10:00:00Z",
        bodyPreview: "+Max for context.",
        isRead: false,
        importance: "normal",
      },
      {
        id: "m2",
        subject: "Demo notes",
        from: "Max Fuerst",
        fromEmail: "max@thewolfpack.agency",
        receivedDateTime: "2026-05-14T10:00:00Z",
        bodyPreview: "Wrapped the demo.",
        isRead: false,
        importance: "normal",
      },
    ]);
    const out = await runMailSearch({ userId: "u1", from: "Max" });
    expect(out?.matches).toHaveLength(1);
    expect(out?.matches[0].id).toBe("m2");
  });

  test("answer renders subjects as markdown links when webLink is present", async () => {
    mockFindThreads.mockResolvedValue([
      {
        id: "m2",
        subject: "Demo notes",
        from: "Max",
        fromEmail: "max@x.co",
        receivedDateTime: "2026-05-14T10:00:00Z",
        bodyPreview: "Wrapped.",
        isRead: false,
        importance: "normal",
        webLink: "https://outlook.office.com/m2",
      },
    ]);
    const out = await runMailSearch({ userId: "u1", from: "Max" });
    expect(out?.answer).toContain("[Demo notes](https://outlook.office.com/m2)");
  });

  test("filters results by topic (case-insensitive substring)", async () => {
    mockFindThreads.mockResolvedValue([
      { id: "m1", subject: "Q2 Retainer", from: "J", fromEmail: "j@x", receivedDateTime: "", bodyPreview: "body", isRead: false, importance: "normal" },
      { id: "m2", subject: "Budget memo", from: "J", fromEmail: "j@x", receivedDateTime: "", bodyPreview: "off-topic", isRead: false, importance: "normal" },
    ]);
    const out = await runMailSearch({ userId: "u1", from: "J", topic: "retainer" });
    expect(out?.matches).toHaveLength(1);
    expect(out?.matches[0].id).toBe("m1");
  });

  test("returns null when matcher throws", async () => {
    mockFindThreads.mockRejectedValue(new Error("down"));
    expect(await runMailSearch({ userId: "u1", from: "J" })).toBeNull();
  });

  test("returns null when nothing matches after topic filter", async () => {
    mockFindThreads.mockResolvedValue([
      { id: "m1", subject: "Hi", from: "J", fromEmail: "j@x", receivedDateTime: "", bodyPreview: "hey", isRead: false, importance: "normal" },
    ]);
    expect(await runMailSearch({ userId: "u1", from: "J", topic: "invoices" })).toBeNull();
  });
});
