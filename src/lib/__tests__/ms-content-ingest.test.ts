/**
 * ms-content-ingest tests — Teams message + OneNote page flow into the
 * Assistant RAG via saveAnswer (direct-write path). Verifies that indexing
 * failures propagate so callers can emit indexing_failed analytics and
 * continue their sync.
 */
 

// Make this file a module (not a script) so top-level `const` declarations
// stay file-scoped and don't collide with sibling test files.
export {};

const mockSaveAnswer = jest.fn();

jest.mock("@/lib/knowledge", () => ({
  saveAnswer: (...args: unknown[]) => mockSaveAnswer(...args),
}));

beforeEach(() => {
  jest.clearAllMocks();
});

describe("indexTeamsMessage", () => {
  it("calls saveAnswer with source='teams_message' and message body", async () => {
    mockSaveAnswer.mockResolvedValue({ id: "k1" });
    const { indexTeamsMessage } = await import("@/lib/learning/ms-content-ingest");
    await indexTeamsMessage("u", {
      msMessageId: "M1",
      chatId: "chat-uuid",
      msChatId: "ms-C1",
      chatTopic: "Q2 planning",
      sender: "Alice",
      body: "Let's push the launch to Friday",
      createdAt: "2026-04-15T10:00:00Z",
    });
    expect(mockSaveAnswer).toHaveBeenCalledTimes(1);
    const [q, a, source, userId] = mockSaveAnswer.mock.calls[0];
    expect(source).toBe("teams_message");
    expect(userId).toBe("u");
    expect(q).toContain("Alice");
    expect(a).toContain("Friday");
  });

  it("skips empty bodies without calling saveAnswer", async () => {
    const { indexTeamsMessage } = await import("@/lib/learning/ms-content-ingest");
    await indexTeamsMessage("u", {
      msMessageId: "M1",
      chatId: "c",
      msChatId: "mc",
      chatTopic: null,
      sender: "A",
      body: "   ",
      createdAt: "2026-04-15T10:00:00Z",
    });
    expect(mockSaveAnswer).not.toHaveBeenCalled();
  });

  it("throws when saveAnswer returns null so callers can log indexing_failed", async () => {
    mockSaveAnswer.mockResolvedValue(null);
    const { indexTeamsMessage } = await import("@/lib/learning/ms-content-ingest");
    await expect(
      indexTeamsMessage("u", {
        msMessageId: "M1",
        chatId: "c",
        msChatId: "mc",
        chatTopic: null,
        sender: "A",
        body: "hi",
        createdAt: "2026-04-15T10:00:00Z",
      }),
    ).rejects.toThrow(/M1/);
  });
});

describe("indexOneNotePage", () => {
  it("saves with source='onenote_page' and preview appended to title", async () => {
    mockSaveAnswer.mockResolvedValue({ id: "k1" });
    const { indexOneNotePage } = await import("@/lib/learning/ms-content-ingest");
    await indexOneNotePage("u", {
      msPageId: "P1",
      title: "Q2 Strategy",
      preview: "Focus on retention",
      modifiedAt: "2026-04-15T10:00:00Z",
    });
    const [q, a, source] = mockSaveAnswer.mock.calls[0];
    expect(source).toBe("onenote_page");
    expect(q).toContain("Q2 Strategy");
    expect(a).toContain("Focus on retention");
  });

  it("indexes shell (title only) when preview is empty", async () => {
    mockSaveAnswer.mockResolvedValue({ id: "k1" });
    const { indexOneNotePage } = await import("@/lib/learning/ms-content-ingest");
    await indexOneNotePage("u", {
      msPageId: "P1",
      title: "Title only",
      preview: "",
      modifiedAt: "2026-04-15T10:00:00Z",
    });
    const [, a] = mockSaveAnswer.mock.calls[0];
    expect(a).toBe("Title only");
  });

  it("throws on null return so caller emits indexing_failed", async () => {
    mockSaveAnswer.mockResolvedValue(null);
    const { indexOneNotePage } = await import("@/lib/learning/ms-content-ingest");
    await expect(
      indexOneNotePage("u", {
        msPageId: "P1",
        title: "t",
        preview: "",
        modifiedAt: "2026-04-15T10:00:00Z",
      }),
    ).rejects.toThrow(/P1/);
  });
});
