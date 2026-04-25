/**
 * Ingest orchestrator tests — covers the routing + persistence path
 * through ingestMeetingMessage with mocked writeQuery / feeds-repo.
 *
 * These are integration-style tests against the orchestrator (the
 * piece Stream A owns), not against Postgres. The feeds-repo and
 * writeQuery boundaries are mocked at the module level.
 */

import type { AutomationDefinition } from "@/lib/automations/types";

const mockWriteQuery = jest.fn();
const mockListFeeds = jest.fn();

jest.mock("@/lib/db", () => ({
  writeQuery: (...args: unknown[]) => mockWriteQuery(...args),
}));

jest.mock("../feeds-repo", () => ({
  listFeeds: (...args: unknown[]) => mockListFeeds(...args),
}));

jest.mock("@/lib/analytics", () => ({
  trackEvent: jest.fn(),
}));

import { ingestMeetingMessage } from "../ingest";

const automation: AutomationDefinition = {
  id: "meeting-insights",
  name: "Meeting Insights",
  owner_label: "Ops",
  description: "",
  active_window_days: { min: -30, max: 30 },
  inbox_filters: {},
  parsers: {},
};

function baseRequest(over: Partial<Parameters<typeof ingestMeetingMessage>[0]> = {}) {
  return {
    automation,
    source_message_id: "graph-1",
    received_at: "2026-04-20T12:00:00Z",
    subject: "Weekly Stand-up",
    from_address: "bot@example.com",
    from_name: "Bot",
    to_addresses: ["team@x.io"],
    cc_addresses: [],
    raw_bytes: Buffer.from("envelope"),
    mime: "message/rfc822",
    body_html: "<p>hello</p>",
    body_preview: "hello",
    attachments: [],
    user_id: "u-1",
    user_role: "ops",
    ...over,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("ingestMeetingMessage", () => {
  it("short-circuits on a duplicate processed artifact", async () => {
    mockWriteQuery.mockResolvedValueOnce({
      rows: [{ id: "art-1", parse_status: "processed", inserted: false }],
    });
    const result = await ingestMeetingMessage(baseRequest());
    expect(result.was_duplicate).toBe(true);
    expect(result.artifact_id).toBe("art-1");
    expect(mockListFeeds).not.toHaveBeenCalled();
  });

  it("quarantines + inserts an exception when no feed matches", async () => {
    mockWriteQuery
      .mockResolvedValueOnce({
        rows: [{ id: "art-1", parse_status: "pending", inserted: true }],
      })
      // UPDATE artifact to quarantined
      .mockResolvedValueOnce({ rows: [{ id: "art-1" }] })
      // INSERT exception
      .mockResolvedValueOnce({ rows: [{ id: "exc-1" }] });
    mockListFeeds.mockResolvedValueOnce([]); // no feeds — guaranteed no match

    const result = await ingestMeetingMessage(baseRequest());
    expect(result.parse_status).toBe("error_quarantined");
    expect(result.exception_id).toBe("exc-1");
    expect(result.message_id).toBeNull();
  });

  it("happy path persists message + marks artifact processed", async () => {
    mockWriteQuery
      .mockResolvedValueOnce({
        rows: [{ id: "art-1", parse_status: "pending", inserted: true }],
      })
      // INSERT message
      .mockResolvedValueOnce({ rows: [{ id: "msg-1", inserted: true }] })
      // UPDATE artifact processed
      .mockResolvedValueOnce({ rows: [{ id: "art-1" }] });

    mockListFeeds.mockResolvedValueOnce([
      {
        id: "f-1",
        slug: "weekly",
        name: "Weekly",
        description: null,
        filters: { sender_match: ["bot@"], subject_match: [] },
        is_enabled: true,
        created_by: "x",
        created_at: "2026-04-01T00:00:00Z",
        updated_at: "2026-04-01T00:00:00Z",
      },
    ]);

    const result = await ingestMeetingMessage(baseRequest());
    expect(result.parse_status).toBe("processed");
    expect(result.feed_id).toBe("f-1");
    expect(result.message_id).toBe("msg-1");
  });

  it("persists attachments via the parser fallback", async () => {
    mockWriteQuery
      .mockResolvedValueOnce({
        rows: [{ id: "art-1", parse_status: "pending", inserted: true }],
      })
      .mockResolvedValueOnce({ rows: [{ id: "msg-1", inserted: true }] })
      // INSERT attachment
      .mockResolvedValueOnce({ rows: [{ id: "att-1" }] })
      // UPDATE artifact processed
      .mockResolvedValueOnce({ rows: [{ id: "art-1" }] });

    mockListFeeds.mockResolvedValueOnce([
      {
        id: "f-1",
        slug: "weekly",
        name: "Weekly",
        description: null,
        filters: { sender_match: [], subject_match: [] },
        is_enabled: true,
        created_by: "x",
        created_at: "2026-04-01T00:00:00Z",
        updated_at: "2026-04-01T00:00:00Z",
      },
    ]);

    const result = await ingestMeetingMessage(
      baseRequest({
        attachments: [
          { name: "agenda.docx", contentType: "application/octet-stream", bytes: Buffer.from("xx") },
        ],
      }),
    );
    expect(result.attachments_persisted).toBe(1);
    expect(result.parse_status).toBe("processed");
  });
});
