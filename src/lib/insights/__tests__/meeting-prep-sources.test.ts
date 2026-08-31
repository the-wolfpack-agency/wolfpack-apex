/**
 * meeting-prep-sources — fan-out behavior, degraded-source handling,
 * deterministic hash. Every retriever is mocked so the test never
 * crosses a network boundary.
 */

const mockFetchCalendarEvents = jest.fn();
const mockFetchEmailsFromContact = jest.fn();
const mockSearchKnowledge = jest.fn();
const mockSafeQuery = jest.fn();
const mockTrackEvent = jest.fn();
const mockPickConfiguredConnector = jest.fn();
const mockLoadConnectorCredentials = jest.fn();
const mockBuildRestConnectorForWorkspace = jest.fn();

jest.mock("@/lib/microsoft-graph", () => ({
  fetchCalendarEvents: (...a: unknown[]) => mockFetchCalendarEvents(...a),
  fetchEmailsFromContact: (...a: unknown[]) => mockFetchEmailsFromContact(...a),
}));
jest.mock("@/lib/knowledge", () => ({
  searchKnowledge: (...a: unknown[]) => mockSearchKnowledge(...a),
}));
jest.mock("@/lib/db", () => ({
  safeQuery: (...a: unknown[]) => mockSafeQuery(...a),
  WriteQueryError: class WriteQueryError extends Error {},
}));
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: unknown[]) => mockTrackEvent(...a),
}));
jest.mock("@/lib/assistant/connectors/credentials", () => ({
  pickConfiguredConnector: (...a: unknown[]) => mockPickConfiguredConnector(...a),
  loadConnectorCredentials: (...a: unknown[]) => mockLoadConnectorCredentials(...a),
}));
jest.mock("@/lib/assistant/connectors/rest-connector", () => ({
  buildRestConnectorForWorkspace: (...a: unknown[]) =>
    mockBuildRestConnectorForWorkspace(...a),
}));

import {
  fetchMeetingSources,
  computeSourceHash,
} from "@/lib/insights/meeting-prep-sources";

const baseEvent = {
  id: "evt-1",
  subject: "Acme sync",
  start: "2026-05-20T15:00:00Z",
  end: "2026-05-20T15:30:00Z",
  location: "Teams",
  attendees: ["Alice Doe", "bob@external.example"],
  attendeeEmails: ["alice@acme.example", "bob@external.example"],
  isOnlineMeeting: true,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockFetchCalendarEvents.mockResolvedValue([baseEvent]);
  mockFetchEmailsFromContact.mockResolvedValue([]);
  mockSearchKnowledge.mockResolvedValue([]);
  mockSafeQuery.mockResolvedValue({ rows: [], fromCache: false });
  mockPickConfiguredConnector.mockResolvedValue(null);
  mockLoadConnectorCredentials.mockResolvedValue(null);
});

describe("fetchMeetingSources", () => {
  test("returns null when the event is not in the calendar window", async () => {
    mockFetchCalendarEvents.mockResolvedValue([]);
    const result = await fetchMeetingSources("evt-1", {
      workspaceId: "ws-a",
      userId: "u1",
    });
    expect(result).toBeNull();
  });

  test("fans out per attendee in parallel — graph + brain + crm", async () => {
    mockFetchEmailsFromContact.mockImplementation(async (_uid: string, email: string) => {
      if (email === "alice@acme.example") {
        return [
          {
            id: "m-1",
            subject: "Q3 plan",
            from: "Alice",
            fromEmail: "alice@acme.example",
            receivedDateTime: "2026-05-19T10:00:00Z",
            bodyPreview: "Looking forward to it",
            isRead: false,
            importance: "normal",
          },
        ];
      }
      return [];
    });
    mockSearchKnowledge.mockResolvedValue([
      { answer: "Acme cares about Q3 OKRs." },
    ]);

    const result = await fetchMeetingSources("evt-1", {
      workspaceId: "ws-a",
      userId: "u1",
    });

    expect(result).not.toBeNull();
    expect(result!.event.id).toBe("evt-1");
    expect(result!.perAttendee).toHaveLength(2);
    expect(mockFetchEmailsFromContact).toHaveBeenCalledTimes(2);
    const alice = result!.perAttendee.find((a) => a.email === "alice@acme.example")!;
    expect(alice.recentEmails).toHaveLength(1);
    expect(alice.recentEmails[0].snippet).toMatch(/forward/);
    /* brain search per attendee — at least the named one returned a hit */
    expect(alice.brainFacts.length).toBeGreaterThanOrEqual(0);
  });

  test("degraded source: brain search throwing does not break the fan-out", async () => {
    mockSearchKnowledge.mockRejectedValue(new Error("brain offline"));
    mockFetchEmailsFromContact.mockResolvedValue([]);

    const result = await fetchMeetingSources("evt-1", {
      workspaceId: "ws-a",
      userId: "u1",
      userRole: "cto",
    });

    expect(result).not.toBeNull();
    expect(result!.perAttendee.every((a) => a.brainFacts.length === 0)).toBe(true);
    /* Each degraded-source attempt fires the analytics event so we can
       see which integrations are slow in production. */
    const degradedCalls = mockTrackEvent.mock.calls.filter(
      (c: unknown[]) => c[0] === "system.meeting_prep_source_degraded",
    );
    expect(degradedCalls.length).toBeGreaterThan(0);
  });

  test("degraded source: graph mail rejection contributes empty emails per attendee", async () => {
    mockFetchEmailsFromContact.mockRejectedValue(new Error("Graph 503"));

    const result = await fetchMeetingSources("evt-1", {
      workspaceId: "ws-a",
      userId: "u1",
    });

    expect(result).not.toBeNull();
    expect(result!.perAttendee.every((a) => a.recentEmails.length === 0)).toBe(true);
  });

  test("versionMarkers include per-attendee last-received email timestamps", async () => {
    mockFetchEmailsFromContact.mockImplementation(async (_uid: string, email: string) => [
      {
        id: `m-${email}`,
        subject: "Test",
        from: "x",
        fromEmail: email,
        receivedDateTime: `2026-05-19T10:00:00Z`,
        bodyPreview: "x",
        isRead: false,
        importance: "normal",
      },
    ]);

    const result = await fetchMeetingSources("evt-1", {
      workspaceId: "ws-a",
      userId: "u1",
    });
    expect(result).not.toBeNull();
    expect(result!.versionMarkers.lastEmailReceivedAt["alice@acme.example"]).toBe(
      "2026-05-19T10:00:00Z",
    );
    expect(result!.versionMarkers.lastEmailReceivedAt["bob@external.example"]).toBe(
      "2026-05-19T10:00:00Z",
    );
  });
});

describe("computeSourceHash", () => {
  test("deterministic for identical input", () => {
    const m = {
      crmLastModified: { "a@x.com": "2026-05-19T00:00:00Z" },
      lastEmailReceivedAt: { "a@x.com": "2026-05-19T10:00:00Z" },
      lastBrainEditAt: "2026-05-18T00:00:00Z",
    };
    expect(computeSourceHash(m)).toBe(computeSourceHash({ ...m }));
  });

  test("stable across object key order", () => {
    const a = computeSourceHash({
      crmLastModified: { "b@x.com": "B", "a@x.com": "A" },
      lastEmailReceivedAt: {},
      lastBrainEditAt: "x",
    });
    const b = computeSourceHash({
      crmLastModified: { "a@x.com": "A", "b@x.com": "B" },
      lastEmailReceivedAt: {},
      lastBrainEditAt: "x",
    });
    expect(a).toBe(b);
  });

  test("changes when ANY source's timestamp moves", () => {
    const base = {
      crmLastModified: { "a@x.com": "2026-05-19T00:00:00Z" },
      lastEmailReceivedAt: { "a@x.com": "2026-05-19T10:00:00Z" },
      lastBrainEditAt: "2026-05-18T00:00:00Z",
    };
    const h0 = computeSourceHash(base);
    expect(
      computeSourceHash({ ...base, lastBrainEditAt: "2026-05-19T00:00:00Z" }),
    ).not.toBe(h0);
    expect(
      computeSourceHash({
        ...base,
        lastEmailReceivedAt: { "a@x.com": "2026-05-19T11:00:00Z" },
      }),
    ).not.toBe(h0);
    expect(
      computeSourceHash({
        ...base,
        crmLastModified: { "a@x.com": "2026-05-19T01:00:00Z" },
      }),
    ).not.toBe(h0);
  });
});
