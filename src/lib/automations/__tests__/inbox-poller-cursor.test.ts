/**
 * Tests for the per-base mailbox cursor module (mailbox-cursors.ts) +
 * the multi-mailbox regression that was previously broken when synthetic-
 * string parsing failed.
 *
 * Background: the inbox poller used to overload
 * `instinct_automation_porsche_poll_state.user_id` with synthetic keys
 * like "<userId>::<base>". Migration 106 introduced a normalized
 * `mailbox_poll_cursors` table keyed on (automation_id, user_id,
 * mailbox_base). These tests pin the new behavior:
 *   1. setCursor writes to the new table with the right composite key.
 *   2. getCursor reads correctly per (user_id, mailbox_base).
 *   3. Legacy fallback fires when the new row is absent and the
 *      `instinct_automation_porsche_poll_state` row exists.
 *   4. Two different mailbox_base values for the same user produce
 *      independent cursors (the regression — was previously fragile
 *      under the synthetic-string trick).
 *   5. Empty mailbox_base ('') represents the legacy default.
 */

jest.mock("@/lib/analytics", () => ({ trackEvent: jest.fn() }));

import { trackEvent } from "@/lib/analytics";

/* The DB layer uses a per-test mock store so we can assert exact reads
   and writes. We model `mailbox_poll_cursors` as an in-memory Map keyed
   by the JSON triple (automation_id, user_id, mailbox_base). The legacy
   `instinct_automation_porsche_poll_state` table is a separate Map
   keyed by (automation_id, user_id) so we can prove the fallback fires. */
type MailboxRow = {
  automation_id: string;
  user_id: string;
  mailbox_base: string;
  delta_link: string | null;
  last_polled_at: string | null;
};
type LegacyRow = {
  automation_id: string;
  user_id: string;
  delta_link: string | null;
};
const mailboxStore = new Map<string, MailboxRow>();
const legacyStore = new Map<string, LegacyRow>();

const mailboxKey = (a: string, u: string, b: string) =>
  JSON.stringify([a, u, b]);
const legacyKey = (a: string, u: string) => JSON.stringify([a, u]);

jest.mock("@/lib/db", () => ({
  query: jest.fn(async (text: string, params: unknown[] = []) => {
    /* mailbox_poll_cursors read for setCursor's "compute ms-since-last-poll"
       enrichment OR the primary getCursor lookup. */
    if (
      text.includes("FROM mailbox_poll_cursors") &&
      text.includes("automation_id = $1") &&
      text.includes("user_id       = $2") &&
      text.includes("mailbox_base  = $3")
    ) {
      const [a, u, b] = params as [string, string, string];
      const row = mailboxStore.get(mailboxKey(a, u, b));
      return { rows: row ? [row] : [] };
    }
    /* Legacy fallback read in getCursor. */
    if (
      text.includes("FROM instinct_automation_porsche_poll_state") &&
      text.includes("automation_id = $1") &&
      text.includes("user_id = $2")
    ) {
      const [a, u] = params as [string, string];
      const row = legacyStore.get(legacyKey(a, u));
      return { rows: row ? [row] : [] };
    }
    return { rows: [] };
  }),
  writeQuery: jest.fn(async (text: string, params: unknown[] = []) => {
    if (text.includes("INSERT INTO mailbox_poll_cursors")) {
      const [a, u, b, link] = params as [string, string, string, string | null];
      mailboxStore.set(mailboxKey(a, u, b), {
        automation_id: a,
        user_id: u,
        mailbox_base: b,
        delta_link: link,
        last_polled_at: new Date().toISOString(),
      });
      return { rows: [{ id: "fake-uuid" }] };
    }
    return { rows: [{ id: "fake-uuid" }] };
  }),
}));

import { getCursor, setCursor } from "@/lib/automations/mailbox-cursors";

beforeEach(() => {
  mailboxStore.clear();
  legacyStore.clear();
  (trackEvent as jest.Mock).mockClear();
  /* Make DATABASE_URL truthy so writeQuery doesn't throw — the real
     helper refuses writes without it (see WriteQueryError "no_database"). */
  process.env.DATABASE_URL = "postgres://test/test";
});

describe("setCursor · writes to mailbox_poll_cursors with composite key", () => {
  it("upserts the row keyed on (automation_id, user_id, mailbox_base)", async () => {
    await setCursor({
      key: {
        automationId: "porsche-classes",
        userId: "homyk@thewolfpack.agency",
        mailboxBase: "/users/homyk%40thewolfpack.agency",
      },
      deltaLink: "https://graph/.../$deltatoken=abc",
      cursorKind: "delta",
      userRole: "ops",
    });

    const stored = mailboxStore.get(
      mailboxKey(
        "porsche-classes",
        "homyk@thewolfpack.agency",
        "/users/homyk%40thewolfpack.agency",
      ),
    );
    expect(stored).toBeDefined();
    expect(stored!.delta_link).toBe("https://graph/.../$deltatoken=abc");
  });

  it("emits automations.cursor_advanced with the mailbox_base in the payload", async () => {
    await setCursor({
      key: {
        automationId: "porsche-classes",
        userId: "u1",
        mailboxBase: "/users/alicia%40thewolfpack.agency",
      },
      deltaLink: "search:2026-04-28T12:00:00Z",
      cursorKind: "search",
      userRole: "ops",
    });

    expect(trackEvent).toHaveBeenCalled();
    const call = (trackEvent as jest.Mock).mock.calls.find(
      (c) => c[0] === "automations.cursor_advanced",
    );
    expect(call).toBeDefined();
    /* trackEvent signature: (name, userId, userRole, payload). */
    expect(call![1]).toBe("u1");
    expect(call![2]).toBe("ops");
    expect(call![3]).toMatchObject({
      automation_id: "porsche-classes",
      mailbox_base: "/users/alicia%40thewolfpack.agency",
      cursor_kind: "search",
    });
    /* First write to this key — ms_since_last_poll uses the -1 sentinel
       (analytics metadata can't carry null; consumers branch on < 0). */
    expect(call![3].ms_since_last_poll).toBe(-1);
  });

  it("ms_since_last_poll is non-null on the SECOND write for the same key", async () => {
    /* Pre-populate the row with an old last_polled_at so the second
       write sees a measurable elapsed time. */
    mailboxStore.set(mailboxKey("porsche-classes", "u1", ""), {
      automation_id: "porsche-classes",
      user_id: "u1",
      mailbox_base: "",
      delta_link: "old-link",
      last_polled_at: new Date(Date.now() - 60_000).toISOString(),
    });

    await setCursor({
      key: { automationId: "porsche-classes", userId: "u1", mailboxBase: "" },
      deltaLink: "new-link",
      cursorKind: "delta",
      userRole: "ops",
    });

    const call = (trackEvent as jest.Mock).mock.calls.find(
      (c) => c[0] === "automations.cursor_advanced",
    );
    expect(call).toBeDefined();
    expect(call![3].ms_since_last_poll).toBeGreaterThan(0);
    expect(call![3].ms_since_last_poll).toBeLessThan(120_000);
  });
});

describe("getCursor · reads correctly per (user_id, mailbox_base)", () => {
  it("returns the delta_link from mailbox_poll_cursors when the row exists", async () => {
    mailboxStore.set(mailboxKey("porsche-classes", "u1", "/users/alicia"), {
      automation_id: "porsche-classes",
      user_id: "u1",
      mailbox_base: "/users/alicia",
      delta_link: "search:2026-04-28T10:00:00Z",
      last_polled_at: new Date().toISOString(),
    });

    const got = await getCursor({
      automationId: "porsche-classes",
      userId: "u1",
      mailboxBase: "/users/alicia",
    });
    expect(got).toBe("search:2026-04-28T10:00:00Z");
  });

  it("returns null when neither table has a matching row", async () => {
    const got = await getCursor({
      automationId: "porsche-classes",
      userId: "nobody",
      mailboxBase: "/users/nobody",
    });
    expect(got).toBeNull();
  });
});

describe("getCursor · legacy fallback path", () => {
  it("falls back to instinct_automation_porsche_poll_state when the new table is empty (default mailbox)", async () => {
    /* Plain userId key in the legacy table — the historical "default
       mailbox" shape. mailbox_poll_cursors has no row. */
    legacyStore.set(legacyKey("porsche-classes", "u1"), {
      automation_id: "porsche-classes",
      user_id: "u1",
      delta_link: "https://graph/legacy-link",
    });

    const got = await getCursor({
      automationId: "porsche-classes",
      userId: "u1",
      mailboxBase: "",
    });
    expect(got).toBe("https://graph/legacy-link");
  });

  it("falls back to the synthetic <userId>::<base> shape for non-default mailbox keys", async () => {
    /* Legacy synthetic-string key — the trick this migration replaces.
       Stored under user_id="u1::/users/alicia" in the old table. */
    legacyStore.set(legacyKey("porsche-classes", "u1::/users/alicia"), {
      automation_id: "porsche-classes",
      user_id: "u1::/users/alicia",
      delta_link: "search:legacy-cursor",
    });

    const got = await getCursor({
      automationId: "porsche-classes",
      userId: "u1",
      mailboxBase: "/users/alicia",
    });
    expect(got).toBe("search:legacy-cursor");
  });

  it("after a setCursor, subsequent getCursor reads the new table (fallback decays)", async () => {
    /* Pre-populate the legacy table to simulate a pre-migration cursor. */
    legacyStore.set(legacyKey("porsche-classes", "u1"), {
      automation_id: "porsche-classes",
      user_id: "u1",
      delta_link: "legacy-link",
    });
    /* First read hits the fallback. */
    const first = await getCursor({
      automationId: "porsche-classes",
      userId: "u1",
      mailboxBase: "",
    });
    expect(first).toBe("legacy-link");

    /* Now write a new cursor — promotes the row into mailbox_poll_cursors. */
    await setCursor({
      key: { automationId: "porsche-classes", userId: "u1", mailboxBase: "" },
      deltaLink: "fresh-link",
      cursorKind: "delta",
      userRole: "ops",
    });

    /* Subsequent reads see the new table and never touch the legacy
       table even though it still has data — the new-row hit short-
       circuits before the fallback query runs. */
    const second = await getCursor({
      automationId: "porsche-classes",
      userId: "u1",
      mailboxBase: "",
    });
    expect(second).toBe("fresh-link");
  });
});

describe("multi-mailbox regression · two bases for the same user produce independent cursors", () => {
  /* Core regression. Under the synthetic-string trick, "u1::/users/alicia"
     and "u1::/users/homyk" lived in the same row id by accident if the
     parser ever stripped the suffix. With the new composite key, the
     two bases are separate rows by construction — there's no parsing,
     no shared identifier. This test pins that property. */

  it("setCursor + setCursor for the same user but different bases creates two independent rows", async () => {
    await setCursor({
      key: {
        automationId: "porsche-classes",
        userId: "u1",
        mailboxBase: "/users/alicia%40thewolfpack.agency",
      },
      deltaLink: "search:alicia-cursor",
      cursorKind: "search",
      userRole: "ops",
    });
    await setCursor({
      key: {
        automationId: "porsche-classes",
        userId: "u1",
        mailboxBase: "/users/homyk%40thewolfpack.agency",
      },
      deltaLink: "search:homyk-cursor",
      cursorKind: "search",
      userRole: "ops",
    });

    expect(mailboxStore.size).toBe(2);

    const aliciaGet = await getCursor({
      automationId: "porsche-classes",
      userId: "u1",
      mailboxBase: "/users/alicia%40thewolfpack.agency",
    });
    const homykGet = await getCursor({
      automationId: "porsche-classes",
      userId: "u1",
      mailboxBase: "/users/homyk%40thewolfpack.agency",
    });
    expect(aliciaGet).toBe("search:alicia-cursor");
    expect(homykGet).toBe("search:homyk-cursor");
  });

  it("advancing one base does NOT clobber the other base's cursor", async () => {
    await setCursor({
      key: { automationId: "porsche-classes", userId: "u1", mailboxBase: "/users/alicia" },
      deltaLink: "alicia-v1",
      cursorKind: "search",
      userRole: "ops",
    });
    await setCursor({
      key: { automationId: "porsche-classes", userId: "u1", mailboxBase: "/users/homyk" },
      deltaLink: "homyk-v1",
      cursorKind: "search",
      userRole: "ops",
    });
    /* Advance only homyk. */
    await setCursor({
      key: { automationId: "porsche-classes", userId: "u1", mailboxBase: "/users/homyk" },
      deltaLink: "homyk-v2",
      cursorKind: "search",
      userRole: "ops",
    });

    const alicia = await getCursor({
      automationId: "porsche-classes",
      userId: "u1",
      mailboxBase: "/users/alicia",
    });
    const homyk = await getCursor({
      automationId: "porsche-classes",
      userId: "u1",
      mailboxBase: "/users/homyk",
    });
    expect(alicia).toBe("alicia-v1");
    expect(homyk).toBe("homyk-v2");
  });

  it("the empty-string mailbox_base is distinct from any non-empty base for the same user", async () => {
    await setCursor({
      key: { automationId: "porsche-classes", userId: "u1", mailboxBase: "" },
      deltaLink: "default-cursor",
      cursorKind: "delta",
      userRole: "ops",
    });
    await setCursor({
      key: { automationId: "porsche-classes", userId: "u1", mailboxBase: "/users/alicia" },
      deltaLink: "alicia-cursor",
      cursorKind: "search",
      userRole: "ops",
    });

    expect(mailboxStore.size).toBe(2);
    expect(
      await getCursor({
        automationId: "porsche-classes",
        userId: "u1",
        mailboxBase: "",
      }),
    ).toBe("default-cursor");
    expect(
      await getCursor({
        automationId: "porsche-classes",
        userId: "u1",
        mailboxBase: "/users/alicia",
      }),
    ).toBe("alicia-cursor");
  });
});
