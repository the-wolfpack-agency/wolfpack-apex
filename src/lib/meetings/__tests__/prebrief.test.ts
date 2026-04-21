/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * computePrebrief — pure composition layer over MS Graph + tasks cache.
 *
 * Coverage:
 *   - happy path with attendees, threads, tasks, linked goal
 *   - meeting id not in calendar window → returns null
 *   - meeting with empty attendees → no thread fetch, empty threads
 *   - linked-goal query throws (missing table) → linkedGoal is null
 *   - tasks cache throws on one status → other statuses still returned
 */

const mockFetchCalendarEvents = jest.fn();
const mockFetchEmailsFromContact = jest.fn();
const mockFindThreads = jest.fn();
const mockListCachedTasks = jest.fn();
const mockSafeQuery = jest.fn();

jest.mock("@/lib/microsoft-graph", () => ({
  fetchCalendarEvents: (...a: any[]) => mockFetchCalendarEvents(...a),
  fetchEmailsFromContact: (...a: any[]) => mockFetchEmailsFromContact(...a),
}));

jest.mock("@/lib/meetings/email-matcher", () => ({
  findThreadsInvolvingAttendees: (...a: any[]) => mockFindThreads(...a),
}));

jest.mock("@/lib/integrations/microsoft-tasks", () => ({
  listCachedTasks: (...a: any[]) => mockListCachedTasks(...a),
}));

jest.mock("@/lib/db", () => ({
  safeQuery: (...a: any[]) => mockSafeQuery(...a),
}));

import { computePrebrief } from "@/lib/meetings/prebrief";

const MEETING = {
  id: "evt-1",
  subject: "Greenfield Q2 Review",
  start: "2026-04-21T14:00:00Z",
  end: "2026-04-21T15:00:00Z",
  location: "Teams",
  attendees: ["james@greenfield.com", "Sarah Chen", "sarah@wolfpack.dev"],
  isOnlineMeeting: true,
};

const EMAIL_NEWER = {
  id: "m2",
  subject: "Re: Retainer",
  from: "James",
  fromEmail: "james@greenfield.com",
  receivedDateTime: "2026-04-21T09:00:00Z",
  bodyPreview: "Confirmed.",
  isRead: false,
  importance: "normal",
};
const EMAIL_OLDER = {
  id: "m1",
  subject: "Invoice",
  from: "James",
  fromEmail: "james@greenfield.com",
  receivedDateTime: "2026-04-18T09:00:00Z",
  bodyPreview: "Please review.",
  isRead: true,
  importance: "normal",
};

const TASK_A = {
  id: "t-a",
  msTaskId: "ms-t-a",
  userId: "u1",
  listId: "L",
  title: "Follow up Greenfield",
  body: null,
  status: "inProgress",
  importance: "normal",
  dueAt: null,
  completedAt: null,
  createdAt: "2026-04-10T00:00:00Z",
  updatedAt: "2026-04-10T00:00:00Z",
  etag: null,
  syncedAt: "2026-04-10T00:00:00Z",
  payload: {},
};
const TASK_B = { ...TASK_A, id: "t-b", msTaskId: "ms-t-b", status: "notStarted", title: "Prep slides" };

beforeEach(() => {
  mockFindThreads.mockReset();
  mockFindThreads.mockResolvedValue([]);
  mockFetchCalendarEvents.mockReset();
  mockFetchEmailsFromContact.mockReset();
  mockListCachedTasks.mockReset();
  mockSafeQuery.mockReset();
});

describe("computePrebrief", () => {
  test("happy path: composes meeting, attendees, threads, tasks, linked goal", async () => {
    mockFetchCalendarEvents.mockResolvedValue([MEETING]);
    // Matcher now returns merged, newest-first results directly.
    mockFindThreads.mockResolvedValue([EMAIL_NEWER, EMAIL_OLDER]);
    mockListCachedTasks.mockImplementation((_u: string, opts: any) => {
      if (opts.status === "inProgress") return Promise.resolve({ tasks: [TASK_A], nextCursor: null });
      if (opts.status === "notStarted") return Promise.resolve({ tasks: [TASK_B], nextCursor: null });
      return Promise.resolve({ tasks: [], nextCursor: null });
    });
    mockSafeQuery.mockResolvedValue({
      rows: [{ to_entity_id: "goal-42", title: "Grow MRR 30%" }],
      fromCache: false,
    });

    const result = await computePrebrief("u1", "evt-1");
    expect(result).not.toBeNull();
    expect(result!.meeting.id).toBe("evt-1");
    // Sarah Chen has no "@" → dropped; the two email-looking entries survive.
    expect(result!.attendeeEmails).toEqual([
      "james@greenfield.com",
      "sarah@wolfpack.dev",
    ]);
    // Newer thread sorts first, and we cap at 3.
    expect(result!.recentThreads).toHaveLength(2);
    expect(result!.recentThreads[0].id).toBe("m2");
    expect(result!.openTasks.map((t) => t.id)).toEqual(
      expect.arrayContaining(["t-a", "t-b"]),
    );
    expect(result!.linkedGoal).toEqual({ id: "goal-42", title: "Grow MRR 30%" });
    expect(result!.decisionSnippet).toBeNull();
  });

  test("returns null when meeting id is not in the calendar window", async () => {
    mockFetchCalendarEvents.mockResolvedValue([MEETING]);
    const result = await computePrebrief("u1", "missing-id");
    expect(result).toBeNull();
    expect(mockFetchEmailsFromContact).not.toHaveBeenCalled();
    expect(mockListCachedTasks).not.toHaveBeenCalled();
  });

  test("meeting with no attendees: skips email fetches, returns empty threads", async () => {
    mockFetchCalendarEvents.mockResolvedValue([{ ...MEETING, attendees: [] }]);
    mockListCachedTasks.mockResolvedValue({ tasks: [], nextCursor: null });
    mockSafeQuery.mockResolvedValue({ rows: [], fromCache: false });

    const result = await computePrebrief("u1", "evt-1");
    expect(result).not.toBeNull();
    expect(result!.attendeeEmails).toEqual([]);
    expect(result!.recentThreads).toEqual([]);
    expect(mockFetchEmailsFromContact).not.toHaveBeenCalled();
  });

  test("linked-goal query throws (missing table) → linkedGoal is null, rest still returned", async () => {
    mockFetchCalendarEvents.mockResolvedValue([MEETING]);
    mockFetchEmailsFromContact.mockResolvedValue([]);
    mockListCachedTasks.mockResolvedValue({ tasks: [], nextCursor: null });
    mockSafeQuery.mockRejectedValue(new Error("relation instinct_entity_links does not exist"));

    const result = await computePrebrief("u1", "evt-1");
    expect(result).not.toBeNull();
    expect(result!.linkedGoal).toBeNull();
    expect(result!.meeting.id).toBe("evt-1");
  });

  test("empty instinct_entity_links row set → linkedGoal is null", async () => {
    mockFetchCalendarEvents.mockResolvedValue([MEETING]);
    mockFetchEmailsFromContact.mockResolvedValue([]);
    mockListCachedTasks.mockResolvedValue({ tasks: [], nextCursor: null });
    mockSafeQuery.mockResolvedValue({ rows: [], fromCache: false });

    const result = await computePrebrief("u1", "evt-1");
    expect(result!.linkedGoal).toBeNull();
  });

  test("tasks cache throws on one status: other statuses still surface", async () => {
    mockFetchCalendarEvents.mockResolvedValue([MEETING]);
    mockFetchEmailsFromContact.mockResolvedValue([]);
    mockSafeQuery.mockResolvedValue({ rows: [], fromCache: false });
    mockListCachedTasks.mockImplementation((_u: string, opts: any) => {
      if (opts.status === "inProgress") return Promise.reject(new Error("boom"));
      return Promise.resolve({ tasks: [TASK_B], nextCursor: null });
    });

    const result = await computePrebrief("u1", "evt-1");
    expect(result!.openTasks.map((t) => t.id)).toContain("t-b");
  });

  test("deduplicates attendee emails (case-insensitive)", async () => {
    mockFetchCalendarEvents.mockResolvedValue([
      { ...MEETING, attendees: ["James@Greenfield.com", "james@greenfield.com"] },
    ]);
    mockFetchEmailsFromContact.mockResolvedValue([]);
    mockListCachedTasks.mockResolvedValue({ tasks: [], nextCursor: null });
    mockSafeQuery.mockResolvedValue({ rows: [], fromCache: false });

    const result = await computePrebrief("u1", "evt-1");
    expect(result!.attendeeEmails).toEqual(["james@greenfield.com"]);
  });

  // Regression: fetchLiveCalendarEvents maps attendees to display NAMES
  // first, falling back to address. An earlier extractEmails required
  // @-in-token and dropped every name-only attendee, producing "No
  // recent email with attendees" even when threads existed. The fix
  // adds a dedicated `attendeeEmails` field we read from first.
  test("uses attendeeEmails field when attendees are display-name-only", async () => {
    mockFetchCalendarEvents.mockResolvedValue([
      {
        ...MEETING,
        attendees: ["Nick Hoxsie", "Nick Homyk"], // display names only
        attendeeEmails: ["nick.h@wolfpack.dev", "nick.homyk@wolfpack.dev"],
      },
    ]);
    mockFindThreads.mockResolvedValue([
      { ...EMAIL_NEWER, fromEmail: "nick.h@wolfpack.dev" },
    ]);
    mockListCachedTasks.mockResolvedValue({ tasks: [], nextCursor: null });
    mockSafeQuery.mockResolvedValue({ rows: [], fromCache: false });

    const result = await computePrebrief("u1", "evt-1");
    expect(result!.attendeeEmails).toEqual([
      "nick.h@wolfpack.dev",
      "nick.homyk@wolfpack.dev",
    ]);
    // findThreadsInvolvingAttendees receives BOTH the display names
    // (for name-based matching when Graph omits addresses) AND the
    // extracted emails — the robust path that finally makes threads
    // appear on live tenants.
    expect(mockFindThreads).toHaveBeenCalledWith(
      "u1",
      ["Nick Hoxsie", "Nick Homyk"],
      ["nick.h@wolfpack.dev", "nick.homyk@wolfpack.dev"],
      3,
    );
    expect(result!.recentThreads).toHaveLength(1);
  });
});
