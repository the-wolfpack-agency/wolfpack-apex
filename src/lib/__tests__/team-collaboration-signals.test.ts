/**
 * team-collaboration-signals tests — exercises the SQL shape + shaping logic.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

export {};

const mockSafeQueryTCS = jest.fn();
jest.mock("@/lib/db", () => ({
  safeQuery: (...args: unknown[]) => mockSafeQueryTCS(...args),
}));

beforeEach(() => {
  jest.clearAllMocks();
});

describe("getChannelActivity", () => {
  it("returns zeros when empty", async () => {
    mockSafeQueryTCS
      .mockResolvedValueOnce({ rows: [] }) // totals
      .mockResolvedValueOnce({ rows: [] }); // perDay
    const mod = await import("@/lib/learning/team-collaboration-signals");
    const res = await mod.getChannelActivity("ch-1", 7);
    expect(res).toMatchObject({
      channel_id: "ch-1",
      window_days: 7,
      total_messages: 0,
      active_participants: 0,
      messages_per_day: [],
    });
  });

  it("aggregates totals + per-day buckets", async () => {
    mockSafeQueryTCS
      .mockResolvedValueOnce({
        rows: [{ total_messages: "17", active_participants: "3" }],
      })
      .mockResolvedValueOnce({
        rows: [
          { day: "2026-04-01", message_count: "5" },
          { day: "2026-04-02", message_count: "12" },
        ],
      });
    const mod = await import("@/lib/learning/team-collaboration-signals");
    const res = await mod.getChannelActivity("ch-1");
    expect(res.total_messages).toBe(17);
    expect(res.active_participants).toBe(3);
    expect(res.messages_per_day).toHaveLength(2);
    expect(res.messages_per_day[1].message_count).toBe(12);
  });
});

describe("getMentionsForUser", () => {
  it("scores urgency based on importance + subject prefix", async () => {
    mockSafeQueryTCS.mockResolvedValueOnce({
      rows: [
        {
          message_id: "1",
          ms_message_id: "msg-1",
          channel_id: "c-1",
          channel_name: "general",
          team_name: "Eng",
          team_id: "t-1",
          sender: "Alice",
          body: "hey look at this blocker",
          subject: "URGENT: ship blocker",
          importance: "normal",
          created_at: new Date("2026-04-01T10:00:00Z").toISOString(),
        },
        {
          message_id: "2",
          ms_message_id: "msg-2",
          channel_id: "c-1",
          channel_name: "general",
          team_name: "Eng",
          team_id: "t-1",
          sender: "Bob",
          body: "fyi",
          subject: null,
          importance: "high",
          created_at: new Date("2026-04-01T11:00:00Z").toISOString(),
        },
        {
          message_id: "3",
          ms_message_id: "msg-3",
          channel_id: "c-2",
          channel_name: "random",
          team_name: "Eng",
          team_id: "t-1",
          sender: "Carol",
          body: "a" + "b".repeat(300),
          subject: null,
          importance: "normal",
          created_at: new Date("2026-04-01T12:00:00Z").toISOString(),
        },
      ],
    });
    const mod = await import("@/lib/learning/team-collaboration-signals");
    const res = await mod.getMentionsForUser("u-1", 14);

    expect(res.total_mentions).toBe(3);
    expect(res.high_importance_count).toBe(1);

    const urgencies = res.recent.map((r) => r.urgency_score);
    expect(urgencies).toContain(0.8); // high
    expect(urgencies).toContain(0.5); // URGENT subject
    expect(urgencies).toContain(0.25); // plain

    // body_preview truncated to 160 chars
    const previewed = res.recent.find((r) => r.message_id === "3");
    expect(previewed!.body_preview.length).toBeLessThanOrEqual(160);

    // Top channels ordered by count desc
    expect(res.top_channels[0].channel_id).toBe("c-1");
    expect(res.top_channels[0].mention_count).toBe(2);
  });

  it("returns empty aggregation when no mentions", async () => {
    mockSafeQueryTCS.mockResolvedValueOnce({ rows: [] });
    const mod = await import("@/lib/learning/team-collaboration-signals");
    const res = await mod.getMentionsForUser("u-1");
    expect(res.total_mentions).toBe(0);
    expect(res.avg_urgency).toBe(0);
    expect(res.recent).toEqual([]);
  });
});

describe("getTopActiveChannels", () => {
  it("maps rows and returns [] on empty", async () => {
    mockSafeQueryTCS.mockResolvedValueOnce({ rows: [] });
    const mod = await import("@/lib/learning/team-collaboration-signals");
    expect(await mod.getTopActiveChannels("u-1")).toEqual([]);
  });

  it("returns shaped entries", async () => {
    mockSafeQueryTCS.mockResolvedValueOnce({
      rows: [
        {
          channel_id: "c-1",
          channel_name: "general",
          team_name: "Eng",
          team_id: "t-1",
          message_count: "42",
          participant_count: "5",
          last_message_at: new Date("2026-04-01T12:00:00Z").toISOString(),
        },
      ],
    });
    const mod = await import("@/lib/learning/team-collaboration-signals");
    const res = await mod.getTopActiveChannels("u-1", 7, 5);
    expect(res).toHaveLength(1);
    expect(res[0]).toMatchObject({
      channel_id: "c-1",
      message_count: 42,
      participant_count: 5,
    });
  });
});
