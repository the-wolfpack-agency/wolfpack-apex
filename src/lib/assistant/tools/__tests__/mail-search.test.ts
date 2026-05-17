const mockFindMail = jest.fn();
jest.mock("@/lib/meetings/email-matcher", () => ({
  findMailBySenderOrRecipient: (...a: unknown[]) => mockFindMail(...a),
}));

import { runMailSearch } from "@/lib/assistant/tools/mail-search";

beforeEach(() => {
  mockFindMail.mockReset();
});

describe("runMailSearch", () => {
  test("returns null when no from/to/topic slot is given", async () => {
    expect(await runMailSearch({ userId: "u1" })).toBeNull();
  });

  test("passes the 'from' needle into the strict matcher", async () => {
    mockFindMail.mockResolvedValue([
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
    expect(mockFindMail).toHaveBeenCalledWith(
      "u1",
      expect.objectContaining({ fromNeedle: "James", limit: 5 }),
    );
    expect(out?.matches[0].subject).toBe("Q2 Retainer");
  });

  test("passes the 'to' needle into the strict matcher", async () => {
    mockFindMail.mockResolvedValue([
      {
        id: "m1",
        subject: "Follow-up",
        from: "Me",
        fromEmail: "me@x.co",
        receivedDateTime: "2026-05-14T10:00:00Z",
        bodyPreview: "Thanks Hoxsie.",
        isRead: true,
        importance: "normal",
      },
    ]);
    const out = await runMailSearch({ userId: "u1", to: "Hoxsie" });
    expect(mockFindMail).toHaveBeenCalledWith(
      "u1",
      expect.objectContaining({ toNeedle: "Hoxsie" }),
    );
    expect(out?.matches[0].subject).toBe("Follow-up");
  });

  test("widens the pool when a topic filter is also set", async () => {
    mockFindMail.mockResolvedValue([
      { id: "m1", subject: "Q2 Retainer", from: "J", fromEmail: "j@x", receivedDateTime: "", bodyPreview: "body", isRead: false, importance: "normal" },
    ]);
    await runMailSearch({ userId: "u1", from: "J", topic: "retainer" });
    expect(mockFindMail).toHaveBeenCalledWith(
      "u1",
      expect.objectContaining({ fromNeedle: "J", limit: 20 }),
    );
  });

  test("answer renders subjects as markdown links when webLink is present", async () => {
    mockFindMail.mockResolvedValue([
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
    mockFindMail.mockResolvedValue([
      { id: "m1", subject: "Q2 Retainer", from: "J", fromEmail: "j@x", receivedDateTime: "", bodyPreview: "body", isRead: false, importance: "normal" },
      { id: "m2", subject: "Budget memo", from: "J", fromEmail: "j@x", receivedDateTime: "", bodyPreview: "off-topic", isRead: false, importance: "normal" },
    ]);
    const out = await runMailSearch({ userId: "u1", from: "J", topic: "retainer" });
    expect(out?.matches).toHaveLength(1);
    expect(out?.matches[0].id).toBe("m1");
  });

  test("returns null when matcher throws", async () => {
    mockFindMail.mockRejectedValue(new Error("down"));
    expect(await runMailSearch({ userId: "u1", from: "J" })).toBeNull();
  });

  test("returns null when nothing matches after topic filter", async () => {
    mockFindMail.mockResolvedValue([
      { id: "m1", subject: "Hi", from: "J", fromEmail: "j@x", receivedDateTime: "", bodyPreview: "hey", isRead: false, importance: "normal" },
    ]);
    expect(await runMailSearch({ userId: "u1", from: "J", topic: "invoices" })).toBeNull();
  });

  test("answer qualifier includes both from + to when both are set", async () => {
    mockFindMail.mockResolvedValue([
      { id: "m1", subject: "Re: thread", from: "A", fromEmail: "a@x", receivedDateTime: "2026-05-14T10:00:00Z", bodyPreview: "x", isRead: true, importance: "normal" },
    ]);
    const out = await runMailSearch({ userId: "u1", from: "A", to: "B" });
    expect(out?.answer).toMatch(/from A/);
    expect(out?.answer).toMatch(/to B/);
  });
});
