/**
 * entity-links.test.ts — L3 polymorphic link CRUD + dedup + analytics.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

const mockWriteQuery = jest.fn();
const mockSafeQuery = jest.fn();
const mockTrack = jest.fn();

jest.mock("@/lib/db", () => ({
  query: jest.fn(),
  safeQuery: (...args: unknown[]) => mockSafeQuery(...args),
  writeQuery: (...args: unknown[]) => mockWriteQuery(...args),
}));
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...args: unknown[]) => mockTrack(...args),
}));

import {
  linkEntities,
  getLinksFrom,
  getLinksTo,
  unlinkEntities,
  type EntityLink,
} from "@/lib/entity-links";

beforeEach(() => {
  jest.clearAllMocks();
  process.env.DATABASE_URL = "postgres://test";
});

function fakeLink(over: Partial<EntityLink> = {}): EntityLink {
  return {
    id: "l-1",
    from_entity_type: "ms_event",
    from_entity_id: "evt-1",
    to_entity_type: "contact",
    to_entity_id: "c-1",
    link_type: "attended_by",
    auto_applied: false,
    applied_by_user_id: "u-1",
    created_at: "2026-04-19T00:00:00Z",
    ...over,
  };
}

describe("linkEntities", () => {
  it("inserts a new link and fires entity.link_created", async () => {
    const row = fakeLink();
    mockWriteQuery.mockResolvedValueOnce({ rows: [row] });
    const out = await linkEntities(
      { entity_type: "ms_event", entity_id: "evt-1" },
      { entity_type: "contact", entity_id: "c-1" },
      "attended_by",
      { userId: "u-1", userRole: "member" },
    );
    expect(out.id).toBe("l-1");
    expect(mockTrack).toHaveBeenCalledTimes(1);
    const [evt, userId, userRole, meta] = mockTrack.mock.calls[0];
    expect(evt).toBe("entity.link_created");
    expect(userId).toBe("u-1");
    expect(userRole).toBe("member");
    expect(meta).toEqual({
      from_type: "ms_event",
      to_type: "contact",
      link_type: "attended_by",
      auto: false,
    });
  });

  it("dedup: returns existing row on conflict, no duplicate event", async () => {
    mockWriteQuery.mockResolvedValueOnce({ rows: [] });
    const existing = fakeLink({ id: "l-existing" });
    mockSafeQuery.mockResolvedValueOnce({ rows: [existing] });
    const out = await linkEntities(
      { entity_type: "ms_event", entity_id: "evt-1" },
      { entity_type: "contact", entity_id: "c-1" },
      "attended_by",
    );
    expect(out.id).toBe("l-existing");
    expect(mockTrack).not.toHaveBeenCalled();
  });

  it("flags auto links and omits userId", async () => {
    mockWriteQuery.mockResolvedValueOnce({ rows: [fakeLink({ auto_applied: true, applied_by_user_id: null })] });
    await linkEntities(
      { entity_type: "ms_event", entity_id: "evt-1" },
      { entity_type: "contact", entity_id: "c-1" },
      "attended_by",
      { auto: true, userId: "ignored" },
    );
    const params = mockWriteQuery.mock.calls[0][1];
    // [id, from_type, from_id, to_type, to_id, link_type, auto, userId]
    expect(params[6]).toBe(true);
    expect(params[7]).toBeNull();
  });
});

describe("getLinksFrom / getLinksTo", () => {
  it("getLinksFrom filters by from + optional link_type", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [fakeLink()] });
    await getLinksFrom("ms_event", "evt-1");
    const call1 = mockSafeQuery.mock.calls[0];
    expect(call1[0]).toMatch(/from_entity_type = \$1/);
    expect(call1[0]).not.toMatch(/link_type = \$/);
    expect(call1[1]).toEqual(["ms_event", "evt-1"]);

    mockSafeQuery.mockResolvedValueOnce({ rows: [fakeLink()] });
    await getLinksFrom("ms_event", "evt-1", { link_type: "attended_by" });
    const call2 = mockSafeQuery.mock.calls[1];
    expect(call2[0]).toMatch(/link_type = \$3/);
    expect(call2[1]).toEqual(["ms_event", "evt-1", "attended_by"]);
  });

  it("getLinksTo filters by to + optional link_type", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [fakeLink()] });
    await getLinksTo("contact", "c-1", { link_type: "attended_by" });
    const call = mockSafeQuery.mock.calls[0];
    expect(call[0]).toMatch(/to_entity_type = \$1/);
    expect(call[0]).toMatch(/link_type = \$3/);
    expect(call[1]).toEqual(["contact", "c-1", "attended_by"]);
  });
});

describe("unlinkEntities", () => {
  it("hard-deletes by id and emits entity.link_removed", async () => {
    const row = fakeLink();
    mockWriteQuery.mockResolvedValueOnce({ rows: [row] });
    const ok = await unlinkEntities("l-1");
    expect(ok).toBe(true);
    expect(mockTrack).toHaveBeenCalledWith(
      "entity.link_removed",
      "u-1",
      "user",
      expect.objectContaining({ link_type: "attended_by", auto: false }),
    );
  });

  it("returns false when no row matched", async () => {
    mockWriteQuery.mockResolvedValueOnce({ rows: [] });
    const ok = await unlinkEntities("missing");
    expect(ok).toBe(false);
    expect(mockTrack).not.toHaveBeenCalled();
  });
});

describe("round-trip", () => {
  it("link → getLinksFrom → getLinksTo → unlink is consistent", async () => {
    const row = fakeLink({ id: "rt-1" });
    mockWriteQuery.mockResolvedValueOnce({ rows: [row] });
    await linkEntities(
      { entity_type: "ms_event", entity_id: "evt-1" },
      { entity_type: "contact", entity_id: "c-1" },
      "attended_by",
      { userId: "u-1" },
    );

    mockSafeQuery.mockResolvedValueOnce({ rows: [row] });
    const fromLinks = await getLinksFrom("ms_event", "evt-1");
    expect(fromLinks.map((l) => l.id)).toContain("rt-1");

    mockSafeQuery.mockResolvedValueOnce({ rows: [row] });
    const toLinks = await getLinksTo("contact", "c-1");
    expect(toLinks.map((l) => l.id)).toContain("rt-1");

    mockWriteQuery.mockResolvedValueOnce({ rows: [row] });
    const ok = await unlinkEntities("rt-1");
    expect(ok).toBe(true);
  });
});
