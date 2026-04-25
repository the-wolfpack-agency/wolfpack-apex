/**
 * Aggregator unit tests — Phase 5 deterministic helpers.
 */

import {
  aggregateActions,
  aggregateDecisions,
  aggregateThemes,
} from "../aggregator";
import type { MeetingAnalysisRecord } from "../types";

function analysis(
  partial: Partial<MeetingAnalysisRecord> & { id: string; message_id: string },
): MeetingAnalysisRecord {
  return {
    summary: null,
    decisions: [],
    action_items: [],
    topics: [],
    attendees: [],
    blockers: [],
    next_steps: [],
    created_at: "2026-04-20T00:00:00Z",
    ...partial,
  };
}

describe("aggregateThemes", () => {
  it("returns [] for empty input", () => {
    expect(aggregateThemes([])).toEqual([]);
  });

  it("dedupes case-insensitively, preserves first casing", () => {
    const themes = aggregateThemes([
      analysis({
        id: "a1",
        message_id: "m1",
        topics: [{ topic: "Pricing" }, { topic: "Headcount" }],
      }),
      analysis({
        id: "a2",
        message_id: "m2",
        topics: [{ topic: "pricing" }, { topic: "Roadmap" }],
      }),
    ]);
    const pricing = themes.find((t) => t.topic.toLowerCase() === "pricing");
    expect(pricing?.topic).toBe("Pricing");
    expect(pricing?.mention_count).toBe(2);
  });

  it("computes first/last seen from messageMeta receivedAt", () => {
    const meta = new Map<string, { received_at: string; subject: string }>([
      ["m1", { received_at: "2026-03-01T00:00:00Z", subject: "" }],
      ["m2", { received_at: "2026-04-01T00:00:00Z", subject: "" }],
    ]);
    const themes = aggregateThemes(
      [
        analysis({ id: "a1", message_id: "m1", topics: [{ topic: "ops" }] }),
        analysis({ id: "a2", message_id: "m2", topics: [{ topic: "ops" }] }),
      ],
      meta,
    );
    expect(themes[0].first_seen).toBe("2026-03-01T00:00:00Z");
    expect(themes[0].last_seen).toBe("2026-04-01T00:00:00Z");
  });

  it("sorts by frequency desc, alphabetical tiebreak", () => {
    const themes = aggregateThemes([
      analysis({
        id: "a1",
        message_id: "m1",
        topics: [{ topic: "alpha" }, { topic: "beta" }, { topic: "alpha" }],
      }),
      analysis({
        id: "a2",
        message_id: "m2",
        topics: [{ topic: "gamma" }],
      }),
    ]);
    expect(themes.map((t) => t.topic)).toEqual(["alpha", "beta", "gamma"]);
  });

  it("ignores empty/whitespace topics", () => {
    expect(
      aggregateThemes([
        analysis({
          id: "a1",
          message_id: "m1",
          topics: [{ topic: "" }, { topic: "   " }, { topic: "real" }],
        }),
      ]),
    ).toHaveLength(1);
  });

  it("tolerates partial analysis presence (missing topics arr)", () => {
    const a = analysis({ id: "a1", message_id: "m1" });
    delete (a as Partial<MeetingAnalysisRecord>).topics;
    expect(aggregateThemes([a as MeetingAnalysisRecord])).toEqual([]);
  });
});

describe("aggregateActions", () => {
  it("dedupes by description+assignee, preserves first occurrence", () => {
    const actions = aggregateActions([
      analysis({
        id: "a1",
        message_id: "m1",
        action_items: [
          { description: "ship pricing page", assignee: "alice" },
          { description: "ship pricing page", assignee: "alice" },
        ],
      }),
      analysis({
        id: "a2",
        message_id: "m2",
        action_items: [
          { description: "Ship Pricing Page", assignee: "Alice" },
          { description: "ship pricing page", assignee: "bob" },
        ],
      }),
    ]);
    expect(actions).toHaveLength(2);
  });

  it("keeps the earliest due date when duplicates carry conflicting ones", () => {
    const actions = aggregateActions([
      analysis({
        id: "a1",
        message_id: "m1",
        action_items: [
          { description: "ship", assignee: "alice", due: "2026-05-15" },
        ],
      }),
      analysis({
        id: "a2",
        message_id: "m2",
        action_items: [
          { description: "ship", assignee: "alice", due: "2026-05-01" },
        ],
      }),
    ]);
    expect(actions[0].due).toBe("2026-05-01");
  });

  it("falls back source_message_id to the analysis's message_id", () => {
    const actions = aggregateActions([
      analysis({
        id: "a1",
        message_id: "m99",
        action_items: [{ description: "x" }],
      }),
    ]);
    expect(actions[0].source_message_id).toBe("m99");
  });

  it("drops empty descriptions", () => {
    expect(
      aggregateActions([
        analysis({
          id: "a1",
          message_id: "m1",
          action_items: [{ description: "" }, { description: "  " }],
        }),
      ]),
    ).toEqual([]);
  });

  it("returns [] for empty input", () => {
    expect(aggregateActions([])).toEqual([]);
  });
});

describe("aggregateDecisions", () => {
  it("dedupes by description case-insensitively", () => {
    const out = aggregateDecisions([
      analysis({
        id: "a1",
        message_id: "m1",
        decisions: [{ description: "Move release to Friday" }],
      }),
      analysis({
        id: "a2",
        message_id: "m2",
        decisions: [{ description: "move release to friday" }],
      }),
    ]);
    expect(out).toHaveLength(1);
  });

  it("returns [] for empty input", () => {
    expect(aggregateDecisions([])).toEqual([]);
  });
});
