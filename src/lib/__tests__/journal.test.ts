/**
 * Team Journal Tests
 *
 * Tests create, update, auto-context, history, team view, and analytics.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { trackEvent } from "@/lib/analytics";

const mockQuery = jest.fn();
const mockSafeQuery = jest.fn();

jest.mock("@/lib/db", () => ({
  query: (...args: any[]) => mockQuery(...args),
  safeQuery: (...args: any[]) => mockSafeQuery(...args),
}));

jest.mock("@/lib/analytics", () => ({
  trackEvent: jest.fn(),
}));

import {
  getOrCreateJournal,
  updateJournal,
  addAutoContext,
  getJournalHistory,
  getTeamJournals,
} from "@/lib/journal";

function setDatabaseUrl(val: string | undefined) {
  if (val === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = val;
  }
}

const FAKE_JOURNAL = {
  id: "j-1",
  user_id: "u1",
  date: "2026-04-04",
  content: "Worked on Apex",
  auto_context: { events: [] },
  mood: "productive",
  highlights: ["Built knowledge base"],
  blockers: [],
  created_at: "2026-04-04T00:00:00Z",
  updated_at: "2026-04-04T00:00:00Z",
};

beforeEach(() => jest.clearAllMocks());
afterEach(() => delete process.env.DATABASE_URL);

// ---------------------------------------------------------------------------
// getOrCreateJournal
// ---------------------------------------------------------------------------
describe("getOrCreateJournal", () => {
  test("creates journal via UPSERT", async () => {
    setDatabaseUrl("postgres://localhost/test");
    mockQuery.mockResolvedValueOnce({ rows: [FAKE_JOURNAL] });

    const journal = await getOrCreateJournal("u1");

    expect(journal.id).toBe("j-1");
    expect(journal.user_id).toBe("u1");
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO apex_journals"),
      expect.arrayContaining(["u1"]),
    );
    expect(trackEvent).toHaveBeenCalledWith(
      "journal.entry_created",
      "u1",
      "dev",
      expect.any(Object),
    );
  });

  test("shadow mode returns demo journal", async () => {
    setDatabaseUrl(undefined);

    const journal = await getOrCreateJournal("u1");

    expect(journal.id).toContain("demo");
    expect(journal.user_id).toBe("u1");
  });

  test("accepts custom date", async () => {
    setDatabaseUrl("postgres://localhost/test");
    mockQuery.mockResolvedValueOnce({ rows: [{ ...FAKE_JOURNAL, date: "2026-03-01" }] });

    const journal = await getOrCreateJournal("u1", "2026-03-01");
    expect(journal.date).toContain("2026-03-01");
  });
});

// ---------------------------------------------------------------------------
// updateJournal
// ---------------------------------------------------------------------------
describe("updateJournal", () => {
  test("updates fields and tracks event", async () => {
    setDatabaseUrl("postgres://localhost/test");
    mockQuery.mockResolvedValueOnce({ rows: [{ ...FAKE_JOURNAL, content: "Updated" }] });

    const updated = await updateJournal("j-1", "u1", {
      content: "Updated",
      mood: "creative",
    });

    expect(updated).not.toBeNull();
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE apex_journals"),
      expect.arrayContaining(["Updated", "creative", "j-1", "u1"]),
    );
    expect(trackEvent).toHaveBeenCalledWith(
      "journal.entry_updated",
      "u1",
      "dev",
      expect.objectContaining({ journal_id: "j-1" }),
    );
  });

  test("returns null when no updates provided", async () => {
    setDatabaseUrl("postgres://localhost/test");

    const result = await updateJournal("j-1", "u1", {});
    expect(result).toBeNull();
  });

  test("shadow mode returns merged data", async () => {
    setDatabaseUrl(undefined);

    const updated = await updateJournal("j-1", "u1", {
      content: "Shadow update",
      mood: "blocked",
    });

    expect(updated).not.toBeNull();
    expect(updated!.content).toBe("Shadow update");
    expect(updated!.mood).toBe("blocked");
  });
});

// ---------------------------------------------------------------------------
// addAutoContext
// ---------------------------------------------------------------------------
describe("addAutoContext", () => {
  test("merges context into JSONB and tracks event", async () => {
    setDatabaseUrl("postgres://localhost/test");
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // INSERT ... ON CONFLICT DO NOTHING
      .mockResolvedValueOnce({ rows: [] }); // UPDATE auto_context

    const ok = await addAutoContext("u1", { calendar: "standup at 9am" });

    expect(ok).toBe(true);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("auto_context = auto_context ||"),
      expect.any(Array),
    );
    expect(trackEvent).toHaveBeenCalledWith(
      "journal.context_added",
      "u1",
      "dev",
      expect.objectContaining({ context_type: "calendar" }),
    );
  });

  test("shadow mode returns true", async () => {
    setDatabaseUrl(undefined);

    const ok = await addAutoContext("u1", { action: "tested" });
    expect(ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getJournalHistory
// ---------------------------------------------------------------------------
describe("getJournalHistory", () => {
  test("returns last N days", async () => {
    setDatabaseUrl("postgres://localhost/test");
    mockSafeQuery.mockResolvedValueOnce({ rows: [FAKE_JOURNAL], fromCache: false });

    const history = await getJournalHistory("u1", 7);

    expect(history).toHaveLength(1);
    expect(mockSafeQuery).toHaveBeenCalledWith(
      expect.stringContaining("CURRENT_DATE"),
      ["u1", 7],
    );
  });

  test("shadow mode returns demo entry", async () => {
    setDatabaseUrl(undefined);

    const history = await getJournalHistory("u1");
    expect(history.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// getTeamJournals
// ---------------------------------------------------------------------------
describe("getTeamJournals", () => {
  test("returns all team journals for date", async () => {
    setDatabaseUrl("postgres://localhost/test");
    mockSafeQuery.mockResolvedValueOnce({
      rows: [FAKE_JOURNAL, { ...FAKE_JOURNAL, id: "j-2", user_id: "u2" }],
      fromCache: false,
    });

    const journals = await getTeamJournals("2026-04-04");

    expect(journals).toHaveLength(2);
  });

  test("shadow mode returns multiple demo journals", async () => {
    setDatabaseUrl(undefined);

    const journals = await getTeamJournals();
    expect(journals.length).toBeGreaterThanOrEqual(2);
  });
});
