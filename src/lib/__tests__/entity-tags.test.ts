/**
 * entity-tags.test.ts — L3 polymorphic tag CRUD + dedup + analytics.
 */

 

const mockQuery = jest.fn();
const mockWriteQuery = jest.fn();
const mockSafeQuery = jest.fn();
const mockTrack = jest.fn();

jest.mock("@/lib/db", () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  safeQuery: (...args: unknown[]) => mockSafeQuery(...args),
  writeQuery: (...args: unknown[]) => mockWriteQuery(...args),
}));

jest.mock("@/lib/analytics", () => ({
  trackEvent: (...args: unknown[]) => mockTrack(...args),
}));

import {
  applyTag,
  getTags,
  findByTag,
  removeTag,
  type EntityTag,
} from "@/lib/entity-tags";

beforeEach(() => {
  jest.clearAllMocks();
  process.env.DATABASE_URL = "postgres://test";
});

function fakeTag(over: Partial<EntityTag> = {}): EntityTag {
  return {
    id: "t-1",
    entity_type: "ms_event",
    entity_id: "evt-1",
    tag_key: "meeting_type",
    tag_value: "pipeline",
    auto_applied: true,
    applied_by_user_id: null,
    created_at: "2026-04-19T00:00:00Z",
    ...over,
  };
}

describe("applyTag", () => {
  it("inserts a new auto tag and fires entity.tag_applied", async () => {
    const row = fakeTag();
    mockWriteQuery.mockResolvedValueOnce({ rows: [row] });
    const out = await applyTag("ms_event", "evt-1", "meeting_type", "pipeline", {
      auto: true,
    });
    expect(out).toEqual(row);
    expect(mockWriteQuery).toHaveBeenCalledTimes(1);
    // Returns a new row → exactly one event emitted.
    expect(mockTrack).toHaveBeenCalledTimes(1);
    const [evt, userId, userRole, meta] = mockTrack.mock.calls[0];
    expect(evt).toBe("entity.tag_applied");
    expect(userId).toBe("system");
    expect(userRole).toBe("system");
    expect(meta).toEqual({ entity_type: "ms_event", tag_key: "meeting_type", auto: true });
  });

  it("returns existing row and DOES NOT fire analytics on dedup", async () => {
    // INSERT ... ON CONFLICT DO NOTHING returned 0 rows
    mockWriteQuery.mockResolvedValueOnce({ rows: [] });
    const existing = fakeTag({ id: "t-existing" });
    mockSafeQuery.mockResolvedValueOnce({ rows: [existing] });

    const out = await applyTag("ms_event", "evt-1", "meeting_type", "pipeline", {
      auto: true,
    });
    expect(out.id).toBe("t-existing");
    expect(mockTrack).not.toHaveBeenCalled();
  });

  it("persists applied_by_user_id for user-applied tags and auto=false", async () => {
    const row = fakeTag({ auto_applied: false, applied_by_user_id: "u-42" });
    mockWriteQuery.mockResolvedValueOnce({ rows: [row] });
    await applyTag("ms_event", "evt-1", "priority", "high", {
      auto: false,
      userId: "u-42",
      userRole: "member",
    });
    const params = mockWriteQuery.mock.calls[0][1];
    // id, entity_type, entity_id, tag_key, tag_value, auto, userId
    expect(params[5]).toBe(false);
    expect(params[6]).toBe("u-42");
    const [, userId, userRole, meta] = mockTrack.mock.calls[0];
    expect(userId).toBe("u-42");
    expect(userRole).toBe("member");
    expect(meta.auto).toBe(false);
  });

  it("does NOT persist userId when auto=true (auto tags are system-only)", async () => {
    mockWriteQuery.mockResolvedValueOnce({ rows: [fakeTag()] });
    await applyTag("ms_event", "evt-1", "x", "y", {
      auto: true,
      userId: "should-be-ignored",
    });
    const params = mockWriteQuery.mock.calls[0][1];
    expect(params[5]).toBe(true);
    expect(params[6]).toBeNull();
  });
});

describe("getTags", () => {
  it("returns all tags for an entity, ordered by created_at", async () => {
    const rows = [fakeTag({ id: "a" }), fakeTag({ id: "b" })];
    mockSafeQuery.mockResolvedValueOnce({ rows });
    const out = await getTags("ms_event", "evt-1");
    expect(out).toHaveLength(2);
    expect(mockSafeQuery.mock.calls[0][0]).toMatch(/ORDER BY created_at ASC/);
    expect(mockSafeQuery.mock.calls[0][1]).toEqual(["ms_event", "evt-1"]);
  });
});

describe("findByTag", () => {
  it("returns distinct entity refs matching tag_key/tag_value", async () => {
    mockSafeQuery.mockResolvedValueOnce({
      rows: [
        { entity_type: "ms_event", entity_id: "e1" },
        { entity_type: "ms_event", entity_id: "e2" },
      ],
    });
    const out = await findByTag("client_domain", "acme.com");
    expect(out).toHaveLength(2);
    expect(mockSafeQuery.mock.calls[0][1]).toEqual(["client_domain", "acme.com"]);
    expect(mockSafeQuery.mock.calls[0][0]).toMatch(/DISTINCT/i);
  });
});

describe("removeTag", () => {
  it("hard-deletes by id and emits entity.tag_removed", async () => {
    const row = fakeTag({ id: "to-delete" });
    mockWriteQuery.mockResolvedValueOnce({ rows: [row] });
    const ok = await removeTag("to-delete");
    expect(ok).toBe(true);
    const [evt, userId, userRole, meta] = mockTrack.mock.calls[0];
    expect(evt).toBe("entity.tag_removed");
    expect(userId).toBe("system");
    expect(userRole).toBe("user");
    expect(meta).toEqual({ entity_type: "ms_event", tag_key: "meeting_type", auto: true });
  });

  it("returns false when no row matched and emits no event", async () => {
    mockWriteQuery.mockResolvedValueOnce({ rows: [] });
    const ok = await removeTag("missing");
    expect(ok).toBe(false);
    expect(mockTrack).not.toHaveBeenCalled();
  });
});

describe("round-trip", () => {
  it("apply → get → find → remove is consistent", async () => {
    const row = fakeTag({ id: "rt-1", tag_value: "demo-tag" });
    // applyTag inserts new
    mockWriteQuery.mockResolvedValueOnce({ rows: [row] });
    const applied = await applyTag("ms_event", "evt-1", "meeting_type", "demo-tag", {
      auto: true,
    });
    expect(applied.id).toBe("rt-1");

    // getTags returns it
    mockSafeQuery.mockResolvedValueOnce({ rows: [row] });
    const tags = await getTags("ms_event", "evt-1");
    expect(tags.map((t) => t.id)).toContain("rt-1");

    // findByTag returns the entity
    mockSafeQuery.mockResolvedValueOnce({
      rows: [{ entity_type: "ms_event", entity_id: "evt-1" }],
    });
    const refs = await findByTag("meeting_type", "demo-tag");
    expect(refs[0]).toEqual({ entity_type: "ms_event", entity_id: "evt-1" });

    // removeTag succeeds
    mockWriteQuery.mockResolvedValueOnce({ rows: [row] });
    const ok = await removeTag("rt-1");
    expect(ok).toBe(true);
  });
});
