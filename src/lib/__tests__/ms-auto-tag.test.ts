/**
 * ms-auto-tag.test.ts — rule engine for MS event auto-tagging.
 *
 * We mock entity-tags.applyTag/getTags + analytics.trackEvent so the test
 * focuses on RULES (what gets tagged) without touching the database layer.
 * entity-tags itself has its own round-trip tests.
 */

 

const mockApplyTag = jest.fn();
const mockGetTags = jest.fn();
const mockTrack = jest.fn();

jest.mock("@/lib/entity-tags", () => ({
  applyTag: (...args: unknown[]) => mockApplyTag(...args),
  getTags: (...args: unknown[]) => mockGetTags(...args),
}));
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...args: unknown[]) => mockTrack(...args),
}));
jest.mock("@/lib/db", () => ({
  query: jest.fn(),
  safeQuery: jest.fn(async () => ({ rows: [], fromCache: true })),
  writeQuery: jest.fn(),
}));

import {
  applyAutoTagsToEvents,
  classifyMeetingType,
  extractDomains,
  subjectHasKeyword,
  type MsEventRow,
} from "@/lib/ms-graph/auto-tag";

beforeEach(() => {
  jest.clearAllMocks();
  mockGetTags.mockResolvedValue([]); // no prior tags by default
  mockApplyTag.mockImplementation(async () => ({ id: "new" }));
  process.env.DATABASE_URL = "postgres://test";
});

describe("extractDomains", () => {
  it("extracts lowercase domains from MS Graph attendees", () => {
    const out = extractDomains([
      { emailAddress: { address: "a@AcMe.com" } },
      { emailAddress: { address: "b@acme.com" } },
      { emailAddress: { address: "c@widgets.io" } },
    ]);
    expect(out.sort()).toEqual(["acme.com", "widgets.io"]);
  });

  it("handles missing / malformed entries gracefully", () => {
    expect(extractDomains(null as any)).toEqual([]);
    expect(extractDomains([null, {}, { emailAddress: {} }, { emailAddress: { address: "nosign" } }])).toEqual([]);
  });

  it("accepts {address} and {email} alternate shapes", () => {
    const out = extractDomains([{ address: "x@a.com" }, { email: "y@b.com" }]);
    expect(out.sort()).toEqual(["a.com", "b.com"]);
  });
});

describe("subjectHasKeyword / classifyMeetingType", () => {
  it("whole-word matching avoids retrofit → retro false positive", () => {
    expect(subjectHasKeyword("Retrofit review", "retro")).toBe(false);
    expect(subjectHasKeyword("Sprint retro", "retro")).toBe(true);
  });

  it("classifies pipeline keywords", () => {
    expect(classifyMeetingType("Acme QBR")).toBe("pipeline");
    expect(classifyMeetingType("Demo for prospect")).toBe("pipeline");
    expect(classifyMeetingType("Discovery call")).toBe("pipeline");
  });

  it("classifies internal keywords", () => {
    expect(classifyMeetingType("Team standup")).toBe("internal");
    expect(classifyMeetingType("Sprint RETRO")).toBe("internal");
  });

  it("returns null for unmatched subjects", () => {
    expect(classifyMeetingType("Random meeting")).toBeNull();
    expect(classifyMeetingType(null)).toBeNull();
    expect(classifyMeetingType("")).toBeNull();
  });
});

describe("applyAutoTagsToEvents", () => {
  const clientDomains = new Set(["acme.com", "widgets.io"]);

  function ev(over: Partial<MsEventRow>): MsEventRow {
    return {
      id: "e1",
      subject: null,
      attendees: [],
      start_time: "2026-04-19T00:00:00Z",
      ...over,
    };
  }

  it("applies client_domain tag for each matched domain", async () => {
    const events: MsEventRow[] = [
      ev({
        id: "e1",
        subject: "Weekly sync",
        attendees: [
          { emailAddress: { address: "a@acme.com" } },
          { emailAddress: { address: "b@acme.com" } }, // same domain
          { emailAddress: { address: "c@widgets.io" } },
          { emailAddress: { address: "d@internal.wolfpack.com" } }, // not a client
        ],
      }),
    ];

    const result = await applyAutoTagsToEvents("u-admin", {
      events,
      clientDomains,
    });

    expect(result.scanned).toBe(1);
    expect(result.applied).toBe(2);
    expect(result.skipped_duplicate).toBe(0);

    const calls = mockApplyTag.mock.calls.map((c) => c.slice(0, 4));
    expect(calls).toContainEqual(["ms_event", "e1", "client_domain", "acme.com"]);
    expect(calls).toContainEqual(["ms_event", "e1", "client_domain", "widgets.io"]);
  });

  it("applies meeting_type tag based on subject keywords", async () => {
    const events: MsEventRow[] = [
      ev({ id: "e1", subject: "Discovery call with Acme" }),
      ev({ id: "e2", subject: "Internal standup" }),
      ev({ id: "e3", subject: "Random chat" }),
    ];
    const result = await applyAutoTagsToEvents("u", { events, clientDomains });
    expect(result.applied).toBe(2);
    const tagged = mockApplyTag.mock.calls.map((c) => ({
      id: c[1],
      key: c[2],
      value: c[3],
    }));
    expect(tagged).toContainEqual({ id: "e1", key: "meeting_type", value: "pipeline" });
    expect(tagged).toContainEqual({ id: "e2", key: "meeting_type", value: "internal" });
  });

  it("is idempotent: re-running skips tags that already exist", async () => {
    // Simulate that e1 already has the auto tags.
    mockGetTags.mockResolvedValueOnce([
      {
        id: "x",
        entity_type: "ms_event",
        entity_id: "e1",
        tag_key: "meeting_type",
        tag_value: "pipeline",
        auto_applied: true,
        applied_by_user_id: null,
        created_at: "",
      },
      {
        id: "y",
        entity_type: "ms_event",
        entity_id: "e1",
        tag_key: "client_domain",
        tag_value: "acme.com",
        auto_applied: true,
        applied_by_user_id: null,
        created_at: "",
      },
    ]);
    const events: MsEventRow[] = [
      ev({
        id: "e1",
        subject: "Discovery call",
        attendees: [{ emailAddress: { address: "a@acme.com" } }],
      }),
    ];
    const result = await applyAutoTagsToEvents("u", { events, clientDomains });
    expect(result.scanned).toBe(1);
    expect(result.applied).toBe(0);
    expect(result.skipped_duplicate).toBe(2);
    expect(mockApplyTag).not.toHaveBeenCalled();
  });

  it("emits entity.auto_tag_run with scanned/applied/skipped_duplicate", async () => {
    const events: MsEventRow[] = [
      ev({ id: "e1", subject: "Demo" }),
      ev({ id: "e2", subject: "Retro" }),
    ];
    await applyAutoTagsToEvents("u", { events, clientDomains });
    expect(mockTrack).toHaveBeenCalledWith(
      "entity.auto_tag_run",
      "u",
      "system",
      { scanned: 2, applied: 2, skipped_duplicate: 0 },
    );
  });

  it("skipAnalytics suppresses the summary event", async () => {
    await applyAutoTagsToEvents("u", {
      events: [ev({ subject: "demo" })],
      clientDomains,
      skipAnalytics: true,
    });
    expect(mockTrack).not.toHaveBeenCalled();
  });

  it("applies BOTH domain and meeting_type tags on a single event", async () => {
    const events: MsEventRow[] = [
      ev({
        id: "e1",
        subject: "Discovery call with Acme",
        attendees: [{ emailAddress: { address: "x@acme.com" } }],
      }),
    ];
    const result = await applyAutoTagsToEvents("u", { events, clientDomains });
    expect(result.applied).toBe(2);
  });
});
