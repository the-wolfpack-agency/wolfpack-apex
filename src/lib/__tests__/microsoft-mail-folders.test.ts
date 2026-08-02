/**
 * Microsoft Mail folder-aware listing tests.
 *
 * Covers `listFolderMessages` for each app folder (inbox, drafts, sent,
 * archived) and the legacy `listInbox` wrapper:
 *   - Each folder maps to the correct Graph well-known name in the URL.
 *   - Drafts + sent silently drop unreadOnly because Graph does not
 *     surface a useful isRead flag for those folders.
 *   - 403 → scope_missing, 429 → rate_limited propagate intact.
 *   - normalizeInboxRow now carries `isDraft` through.
 */
 

const mockTrack = jest.fn();
const mockQuery = jest.fn();
const mockGetValidToken = jest.fn();
const mockRecordAudit = jest.fn();

jest.mock("@/lib/analytics", () => ({
  trackEvent: (...args: any[]) => mockTrack(...args),
}));
jest.mock("@/lib/db", () => ({
  query: (...args: any[]) => mockQuery(...args),
  safeQuery: jest.fn(),
  pool: { query: jest.fn() },
  // activePool() replaced direct pool use so every query is routed to the
  // tenant's database. The mock must expose it or the module under test
  // calls undefined.
  activePool: () => ({ query: jest.fn() }),
}));
jest.mock("@/lib/microsoft-graph", () => ({
  getValidToken: (...args: any[]) => mockGetValidToken(...args),
}));
jest.mock("@/lib/audit-log", () => ({
  recordAudit: (...args: any[]) => mockRecordAudit(...args),
}));

const realFetch = global.fetch;
const fetchMock = jest.fn();

beforeAll(() => {
  (global as any).fetch = fetchMock;
});
afterAll(() => {
  (global as any).fetch = realFetch;
});

beforeEach(() => {
  jest.clearAllMocks();
  fetchMock.mockReset();
  mockGetValidToken.mockResolvedValue({ accessToken: "tok-folders" });
  mockQuery.mockResolvedValue({ rows: [] });
  mockRecordAudit.mockResolvedValue({ id: "a", seq: 1, entryHash: "h" });
});

function okJson(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as any;
}

function err(status: number, body: any = {}) {
  return {
    ok: false,
    status,
    headers: new Headers(),
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as any;
}

import {
  listFolderMessages,
  listInbox,
  isAppMailFolder,
  appMailFolderToGraph,
  folderSupportsUnreadFilter,
  __internal,
  type AppMailFolder,
} from "@/lib/integrations/microsoft-mail";

describe("isAppMailFolder", () => {
  it("accepts each known folder", () => {
    for (const f of ["inbox", "drafts", "sent", "archived"]) {
      expect(isAppMailFolder(f)).toBe(true);
    }
  });
  it("rejects unknown / wrong-shape inputs", () => {
    for (const v of ["sentitems", "archive", "INBOX", "", null, undefined, 1, {}]) {
      expect(isAppMailFolder(v)).toBe(false);
    }
  });
});

describe("appMailFolderToGraph", () => {
  it("maps each app folder to the right Graph well-known name", () => {
    expect(appMailFolderToGraph("inbox")).toBe("inbox");
    expect(appMailFolderToGraph("drafts")).toBe("drafts");
    expect(appMailFolderToGraph("sent")).toBe("sentitems");
    expect(appMailFolderToGraph("archived")).toBe("archive");
  });
});

describe("folderSupportsUnreadFilter", () => {
  it("only inbox + archived support the unread toggle", () => {
    expect(folderSupportsUnreadFilter("inbox")).toBe(true);
    expect(folderSupportsUnreadFilter("archived")).toBe(true);
    expect(folderSupportsUnreadFilter("drafts")).toBe(false);
    expect(folderSupportsUnreadFilter("sent")).toBe(false);
  });
});

describe("__internal.resolveFolder", () => {
  it("accepts canonical app folders", () => {
    expect(__internal.resolveFolder("inbox")).toEqual({ appFolder: "inbox", graphFolder: "inbox" });
    expect(__internal.resolveFolder("drafts")).toEqual({ appFolder: "drafts", graphFolder: "drafts" });
    expect(__internal.resolveFolder("sent")).toEqual({ appFolder: "sent", graphFolder: "sentitems" });
    expect(__internal.resolveFolder("archived")).toEqual({
      appFolder: "archived",
      graphFolder: "archive",
    });
  });
  it("accepts legacy Graph well-known names", () => {
    expect(__internal.resolveFolder("sentitems")).toEqual({
      appFolder: "sent",
      graphFolder: "sentitems",
    });
    expect(__internal.resolveFolder("archive")).toEqual({
      appFolder: "archived",
      graphFolder: "archive",
    });
  });
  it("falls back to inbox on unknown", () => {
    expect(__internal.resolveFolder("garbage")).toEqual({ appFolder: "inbox", graphFolder: "inbox" });
    expect(__internal.resolveFolder(undefined)).toEqual({ appFolder: "inbox", graphFolder: "inbox" });
    expect(__internal.resolveFolder("")).toEqual({ appFolder: "inbox", graphFolder: "inbox" });
  });
});

describe("listFolderMessages — folder mapping", () => {
  const cases: { folder: AppMailFolder; graph: string }[] = [
    { folder: "inbox", graph: "inbox" },
    { folder: "drafts", graph: "drafts" },
    { folder: "sent", graph: "sentitems" },
    { folder: "archived", graph: "archive" },
  ];

  for (const { folder, graph } of cases) {
    it(`hits /me/mailFolders/${graph}/messages for folder=${folder}`, async () => {
      fetchMock.mockResolvedValueOnce(okJson({ value: [], "@odata.count": 0 }));
      const r = await listFolderMessages("u1", { folder });
      expect(r.ok).toBe(true);
      const url = String(fetchMock.mock.calls[0][0]);
      expect(url).toContain(`/me/mailFolders/${graph}/messages`);
      expect(url).toContain("isDraft"); // new $select carries isDraft
    });
  }
});

describe("listFolderMessages — unread filter", () => {
  it("inbox honors unreadOnly + reports unreadCount", async () => {
    fetchMock.mockResolvedValueOnce(okJson({ value: [], "@odata.count": 4 }));
    const r = await listFolderMessages("u1", { folder: "inbox", unreadOnly: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.unreadCount).toBe(4);
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("isRead%20eq%20false");
  });

  it("archived honors unreadOnly", async () => {
    fetchMock.mockResolvedValueOnce(okJson({ value: [], "@odata.count": 2 }));
    const r = await listFolderMessages("u1", { folder: "archived", unreadOnly: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.unreadCount).toBe(2);
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("isRead%20eq%20false");
  });

  it("drafts silently drops unreadOnly + leaves unreadCount undefined", async () => {
    fetchMock.mockResolvedValueOnce(okJson({ value: [], "@odata.count": 99 }));
    const r = await listFolderMessages("u1", { folder: "drafts", unreadOnly: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.unreadCount).toBeUndefined();
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).not.toContain("isRead%20eq%20false");
  });

  it("sent silently drops unreadOnly", async () => {
    fetchMock.mockResolvedValueOnce(okJson({ value: [], "@odata.count": 99 }));
    const r = await listFolderMessages("u1", { folder: "sent", unreadOnly: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.unreadCount).toBeUndefined();
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).not.toContain("isRead%20eq%20false");
  });
});

describe("listFolderMessages — error propagation", () => {
  it("403 returns scope_missing", async () => {
    fetchMock.mockResolvedValueOnce(
      err(403, { error: { code: "AccessDenied", message: "missing scope" } }),
    );
    const r = await listFolderMessages("u1", { folder: "drafts" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("scope_missing");
  });

  it("429 returns rate_limited with retryAfter", async () => {
    fetchMock.mockResolvedValueOnce({
      ...err(429, {}),
      headers: new Headers({ "Retry-After": "11" }),
    });
    const r = await listFolderMessages("u1", { folder: "sent" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("rate_limited");
    expect(r.retryAfter).toBe(11);
  });

  it("not_connected when no token", async () => {
    mockGetValidToken.mockResolvedValueOnce(null);
    const r = await listFolderMessages("u1", { folder: "archived" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("not_connected");
  });
});

describe("listFolderMessages — row normalization carries isDraft", () => {
  it("isDraft=true is preserved on drafts rows", async () => {
    fetchMock.mockResolvedValueOnce(
      okJson({
        value: [
          {
            id: "d1",
            subject: "WIP",
            from: { emailAddress: { name: "Me", address: "me@x.co" } },
            receivedDateTime: "2026-04-22T10:00:00Z",
            bodyPreview: "Half-done",
            isRead: true,
            hasAttachments: false,
            importance: "normal",
            webLink: "",
            isDraft: true,
          },
        ],
      }),
    );
    const r = await listFolderMessages("u1", { folder: "drafts" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.messages[0].isDraft).toBe(true);
  });
});

describe("listInbox — backwards compatibility", () => {
  it("default (no folder) hits /me/mailFolders/inbox/messages", async () => {
    fetchMock.mockResolvedValueOnce(okJson({ value: [], "@odata.count": 0 }));
    await listInbox("u1");
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("/me/mailFolders/inbox/messages");
  });

  it("legacy folder='sentitems' delegates correctly", async () => {
    fetchMock.mockResolvedValueOnce(okJson({ value: [], "@odata.count": 0 }));
    await listInbox("u1", { folder: "sentitems" });
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("/me/mailFolders/sentitems/messages");
  });
});
