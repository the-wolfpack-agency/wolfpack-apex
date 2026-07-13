/**
 * microsoft-tasks — Outlook field enrichment.
 *
 * Covers the pure validateOutlookTaskFields guard and that createTask maps the
 * new fields (startDateTime, reminderDateTime + isReminderOn, categories) onto
 * the Graph POST body exactly as Microsoft To Do expects. Graph + DB are
 * mocked; the integration must never throw on these paths.
 */

export {};

const mockTrack = jest.fn();
const mockGetValidToken = jest.fn();
const mockQuery = jest.fn();
const mockSafeQuery = jest.fn();

jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: any[]) => mockTrack(...a) }));
jest.mock("@/lib/microsoft-graph", () => ({ getValidToken: (...a: any[]) => mockGetValidToken(...a) }));
jest.mock("@/lib/db", () => ({
  query: (...a: any[]) => mockQuery(...a),
  safeQuery: (...a: any[]) => mockSafeQuery(...a),
}));

const realFetch = global.fetch;
const fetchMock = jest.fn();
beforeAll(() => { (global as any).fetch = fetchMock; });
afterAll(() => { (global as any).fetch = realFetch; });

function ok(data: unknown, status = 200): any {
  return {
    ok: true,
    status,
    headers: { get: () => null },
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  };
}

import {
  validateOutlookTaskFields,
  createTask,
} from "@/lib/integrations/microsoft-tasks";

beforeEach(() => {
  jest.clearAllMocks();
  mockTrack.mockResolvedValue(undefined);
  mockGetValidToken.mockResolvedValue({ accessToken: "tok" });
});

describe("validateOutlookTaskFields", () => {
  it("accepts an empty patch", () => {
    expect(validateOutlookTaskFields({})).toBeNull();
  });
  it("accepts valid ISO dates + categories", () => {
    expect(
      validateOutlookTaskFields({
        dueAt: "2026-08-01T00:00:00.000Z",
        reminderAt: "2026-08-01T09:00:00.000Z",
        startAt: "2026-07-30T00:00:00.000Z",
        isReminderOn: true,
        categories: ["A", "B"],
      }),
    ).toBeNull();
  });
  it("rejects an unparseable date", () => {
    expect(validateOutlookTaskFields({ reminderAt: "banana" })).toMatch(/reminderAt/);
  });
  it("rejects non-string categories", () => {
    expect(validateOutlookTaskFields({ categories: [1 as unknown as string] })).toMatch(/categories/);
  });
  it("rejects a non-boolean isReminderOn", () => {
    expect(validateOutlookTaskFields({ isReminderOn: "yes" as unknown as boolean })).toMatch(/isReminderOn/);
  });
  it("allows null dates (clearing a field)", () => {
    expect(validateOutlookTaskFields({ dueAt: null, startAt: null, reminderAt: null })).toBeNull();
  });
});

describe("createTask — Graph body mapping", () => {
  it("maps reminder/start/categories onto the To Do Graph POST body", async () => {
    // Graph POST create response.
    fetchMock.mockResolvedValueOnce(
      ok({
        id: "ms-task-1",
        title: "Ship it",
        status: "notStarted",
        importance: "high",
        reminderDateTime: { dateTime: "2026-08-01T09:00:00.0000000", timeZone: "UTC" },
        isReminderOn: true,
        categories: ["Client"],
      }),
    );
    // ensureListInCache SELECT → existing list row.
    mockSafeQuery
      .mockResolvedValueOnce({ rows: [{ id: "list-uuid" }] }) // ensureListInCache
      .mockResolvedValueOnce({
        rows: [{
          id: "local-1", ms_task_id: "ms-task-1", user_id: "u1", list_id: "list-uuid",
          title: "Ship it", body: null, status: "notStarted", importance: "high",
          due_at: null, start_at: null, reminder_at: "2026-08-01T09:00:00.000Z",
          is_reminder_on: true, categories: ["Client"], completed_at: null,
          created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
          etag: null, synced_at: new Date().toISOString(), payload: "{}", list_ms_id: "ms-list",
        }],
      }); // getCachedTaskById
    // upsertTask INSERT → returns local id.
    mockQuery.mockResolvedValue({ rows: [{ id: "local-1" }] });

    const task = await createTask("u1", "ms-list", {
      title: "Ship it",
      startAt: "2026-07-30T00:00:00.000Z",
      reminderAt: "2026-08-01T09:00:00.000Z",
      isReminderOn: true,
      categories: ["Client"],
      importance: "high",
    });

    expect(task.msTaskId).toBe("ms-task-1");
    expect(task.isReminderOn).toBe(true);
    expect(task.categories).toEqual(["Client"]);

    // First fetch call is the Graph POST — assert the body Graph receives.
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse((init as { body: string }).body);
    expect(body.startDateTime).toEqual({ dateTime: "2026-07-30T00:00:00.000Z", timeZone: "UTC" });
    expect(body.reminderDateTime).toEqual({ dateTime: "2026-08-01T09:00:00.000Z", timeZone: "UTC" });
    expect(body.isReminderOn).toBe(true);
    expect(body.categories).toEqual(["Client"]);
    expect(body.importance).toBe("high");
  });
});
