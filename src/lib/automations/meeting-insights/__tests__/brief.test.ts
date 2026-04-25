/**
 * brief.ts — Phase 4 calendar-event brief unit tests.
 *
 * `pickFeedForEventTitle` is pure and tested first. `assembleBrief`
 * exercises the DB-backed path with mocked feeds-repo / messages-repo
 * / analyses-repo / db.
 */

import type { MeetingFeed, MeetingAnalysisRecord } from "../types";

const mockListFeeds = jest.fn();
jest.mock("../feeds-repo", () => ({
  listFeeds: (...a: unknown[]) => mockListFeeds(...a),
}));

const mockListMessagesForFeed = jest.fn();
jest.mock("../messages-repo", () => ({
  listMessagesForFeed: (...a: unknown[]) => mockListMessagesForFeed(...a),
}));

const mockGetAnalysesByMessageIds = jest.fn();
jest.mock("../analyses-repo", () => ({
  getAnalysesByMessageIds: (...a: unknown[]) =>
    mockGetAnalysesByMessageIds(...a),
}));

const mockQuery = jest.fn();
jest.mock("@/lib/db", () => ({
  query: (...a: unknown[]) => mockQuery(...a),
  writeQuery: jest.fn(),
}));

import { assembleBrief, pickFeedForEventTitle } from "../brief";

function feed(partial: Partial<MeetingFeed> & { slug: string }): MeetingFeed {
  return {
    id: `id-${partial.slug}`,
    name: partial.slug,
    description: null,
    is_enabled: true,
    created_by: "u",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    filters: { sender_match: [], subject_match: [] },
    ...partial,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("pickFeedForEventTitle", () => {
  it("returns null when feeds is empty", () => {
    expect(pickFeedForEventTitle([], "Standup")).toBeNull();
  });

  it("returns null when no subject_match substring is present", () => {
    expect(
      pickFeedForEventTitle(
        [feed({ slug: "x", filters: { sender_match: [], subject_match: ["other"] } })],
        "Pricing review",
      ),
    ).toBeNull();
  });

  it("matches case-insensitively", () => {
    const f = feed({
      slug: "x",
      filters: { sender_match: [], subject_match: ["StAnDuP"] },
    });
    expect(pickFeedForEventTitle([f], "weekly standup")).toBe(f);
  });

  it("ignores disabled feeds even on match", () => {
    expect(
      pickFeedForEventTitle(
        [
          feed({
            slug: "x",
            is_enabled: false,
            filters: { sender_match: [], subject_match: ["standup"] },
          }),
        ],
        "Standup tomorrow",
      ),
    ).toBeNull();
  });

  it("picks the most-specific feed (longest matching substring)", () => {
    const generic = feed({
      slug: "generic",
      filters: { sender_match: [], subject_match: ["meeting"] },
    });
    const specific = feed({
      slug: "specific",
      filters: { sender_match: [], subject_match: ["porsche weekly"] },
    });
    const winner = pickFeedForEventTitle(
      [generic, specific],
      "Porsche Weekly Meeting",
    );
    expect(winner).toBe(specific);
  });

  it("breaks ties by slug ascending (deterministic)", () => {
    const a = feed({
      slug: "alpha",
      filters: { sender_match: [], subject_match: ["weekly"] },
    });
    const b = feed({
      slug: "beta",
      filters: { sender_match: [], subject_match: ["weekly"] },
    });
    expect(pickFeedForEventTitle([b, a], "Weekly Sync")).toBe(a);
  });

  it("ignores empty filter strings", () => {
    expect(
      pickFeedForEventTitle(
        [feed({ slug: "x", filters: { sender_match: [], subject_match: ["", "  "] } })],
        "anything",
      ),
    ).toBeNull();
  });
});

describe("assembleBrief", () => {
  const matchingFeed = feed({
    slug: "porsche-weekly",
    name: "Porsche Weekly",
    filters: { sender_match: [], subject_match: ["porsche weekly"] },
  });

  function setupHappyPath(opts: {
    analyses?: Map<string, MeetingAnalysisRecord>;
    exceptionsRows?: Array<{ n: string }>;
  } = {}) {
    mockListFeeds.mockResolvedValueOnce([matchingFeed]);
    mockListMessagesForFeed.mockResolvedValueOnce([
      {
        id: "m1",
        feed_id: matchingFeed.id,
        source_message_id: "g1",
        artifact_id: "a1",
        subject: "Porsche Weekly — recap",
        from_address: "ops@example.com",
        from_name: null,
        to_addresses: [],
        cc_addresses: [],
        received_at: "2026-04-15T15:00:00Z",
        body_text: "",
        body_html: null,
        has_attachments: false,
        created_at: "2026-04-15T15:00:00Z",
      },
      {
        id: "m2",
        feed_id: matchingFeed.id,
        source_message_id: "g2",
        artifact_id: "a2",
        subject: "Porsche Weekly — kickoff",
        from_address: "ops@example.com",
        from_name: null,
        to_addresses: [],
        cc_addresses: [],
        received_at: "2026-04-08T15:00:00Z",
        body_text: "",
        body_html: null,
        has_attachments: false,
        created_at: "2026-04-08T15:00:00Z",
      },
    ]);
    mockGetAnalysesByMessageIds.mockResolvedValueOnce(
      opts.analyses ?? new Map(),
    );
    mockQuery.mockResolvedValueOnce({ rows: opts.exceptionsRows ?? [{ n: "0" }] });
  }

  it("returns null when no feed matches the title", async () => {
    mockListFeeds.mockResolvedValueOnce([matchingFeed]);
    const out = await assembleBrief("Random one-off", "2026-04-22T15:00:00Z", []);
    expect(out).toBeNull();
    expect(mockListMessagesForFeed).not.toHaveBeenCalled();
  });

  it("composes a brief with recent_messages, no analyses present", async () => {
    setupHappyPath();
    const brief = await assembleBrief(
      "Porsche Weekly — Apr 22",
      "2026-04-22T15:00:00Z",
      ["nick@example.com"],
    );
    expect(brief).not.toBeNull();
    expect(brief?.feed.slug).toBe("porsche-weekly");
    expect(brief?.recent_messages).toHaveLength(2);
    expect(brief?.recent_messages.every((m) => !m.analyzed)).toBe(true);
    expect(brief?.open_action_items).toEqual([]);
    expect(brief?.recurring_topics).toEqual([]);
    expect(brief?.exception_count).toBe(0);
  });

  it("includes analyses when Phase 2/3 has produced them", async () => {
    const analyses = new Map<string, MeetingAnalysisRecord>([
      [
        "m1",
        {
          id: "an1",
          message_id: "m1",
          summary: "Pricing decisions confirmed",
          decisions: [],
          action_items: [
            { description: "ship pricing page", assignee: "alicia" },
          ],
          topics: [{ topic: "pricing" }, { topic: "roadmap" }],
          attendees: [],
          blockers: [],
          next_steps: [],
          created_at: "2026-04-15T16:00:00Z",
        },
      ],
      [
        "m2",
        {
          id: "an2",
          message_id: "m2",
          summary: null,
          decisions: [],
          action_items: [
            { description: "ship pricing page", assignee: "alicia" },
          ],
          topics: [{ topic: "Pricing" }],
          attendees: [],
          blockers: [],
          next_steps: [],
          created_at: "2026-04-08T16:00:00Z",
        },
      ],
    ]);
    setupHappyPath({ analyses });
    const brief = await assembleBrief(
      "Porsche Weekly — Apr 22",
      "2026-04-22T15:00:00Z",
      [],
    );
    expect(brief?.recent_messages.every((m) => m.analyzed)).toBe(true);
    expect(brief?.recent_messages[0].summary).toBe("Pricing decisions confirmed");
    // Action item deduped across the two messages.
    expect(brief?.open_action_items).toHaveLength(1);
    // "Pricing" appears in both, which qualifies as recurring (>=2).
    expect(brief?.recurring_topics.some((t) => t.topic.toLowerCase() === "pricing")).toBe(true);
  });

  it("surfaces exception_count when query returns rows", async () => {
    setupHappyPath({ exceptionsRows: [{ n: "3" }] });
    const brief = await assembleBrief(
      "Porsche Weekly",
      "2026-04-22T15:00:00Z",
      [],
    );
    expect(brief?.exception_count).toBe(3);
  });

  it("tolerates exception query errors (returns 0)", async () => {
    mockListFeeds.mockResolvedValueOnce([matchingFeed]);
    mockListMessagesForFeed.mockResolvedValueOnce([]);
    mockGetAnalysesByMessageIds.mockResolvedValueOnce(new Map());
    mockQuery.mockRejectedValueOnce(new Error("relation does not exist"));
    const brief = await assembleBrief(
      "Porsche Weekly",
      "2026-04-22T15:00:00Z",
      [],
    );
    expect(brief?.exception_count).toBe(0);
  });
});
