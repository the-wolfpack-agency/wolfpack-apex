 
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

  test("passes the 'from' person into the email matcher", async () => {
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
    expect(mockFindThreads).toHaveBeenCalledWith("u1", ["James"], [], 5);
    expect(out?.matches[0].subject).toBe("Q2 Retainer");
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
