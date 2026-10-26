/**
 * Contract: every Graph-backed route answers "Microsoft not connected" without
 * a 401.
 *
 *   reads   (GET)                    -> 200 { connected: false, provider, error, notice, ...empty data key }
 *   actions (POST / PATCH / DELETE)  -> 409 { connected: false, provider, error, notice }
 *   no Instinct session              -> 401 (the only reason for a 401)
 *
 * Each integration module is the real module with its data functions replaced
 * by a stub that reports "not connected" the way that module does in
 * production: Result-style modules return { ok: false, code: "not_connected",
 * status: 401 }; the throw-style modules throw their own error class with
 * status 401 (Graph rejected the token). The routes, the helper, the status
 * mapping and the body are all real.
 *
 * The scope_missing (403) path is covered per route in the existing route
 * tests (e.g. src/app/api/emails/inbox/__tests__/route.test.ts) and is
 * unchanged by this contract.
 */

import { NextRequest } from "next/server";

const mockGetUser = jest.fn();
const mockTrackEvent = jest.fn();

jest.mock("@/lib/auth", () => ({
  ...jest.requireActual("@/lib/auth"),
  getUserFromRequest: (...a: unknown[]) => mockGetUser(...a),
}));
jest.mock("@/lib/auth/require-capability", () => {
  const { NextResponse } = jest.requireActual("next/server");
  return {
    requireCapability: async () => {
      const user = mockGetUser();
      if (!user) {
        return { ok: false, response: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
      }
      return { ok: true, user, capabilities: new Set<string>() };
    },
  };
});
jest.mock("@/lib/analytics", () => ({
  ...jest.requireActual("@/lib/analytics"),
  trackEvent: (...a: unknown[]) => mockTrackEvent(...a),
}));
jest.mock("@/lib/audit-log", () => ({
  recordAudit: jest.fn(async () => undefined),
  extractRequestMetadata: jest.fn(() => ({})),
}));
jest.mock("@/lib/db", () => ({
  ...jest.requireActual("@/lib/db"),
  query: jest.fn(async () => ({ rows: [] })),
  safeQuery: jest.fn(async () => ({ rows: [] })),
}));
jest.mock("@/lib/ms-graph/sync-state", () => {
  const actual = jest.requireActual("@/lib/ms-graph/sync-state");
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(actual)) {
    out[k] = typeof v === "function" ? jest.fn(async () => null) : v;
  }
  return out;
});

/** Replace each data function of an integration module with a not-connected
 *  stub. Classes (error types) and synchronous helpers stay real. */
function mockNotConnectedModule(path: string, errorClass?: string) {
  const actual = jest.requireActual(path) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(actual)) {
    // Only async functions talk to Graph; sync helpers (validators, type
    // guards, error classes) stay real.
    const keep = typeof v !== "function" || (v as { constructor: { name: string } }).constructor.name !== "AsyncFunction";
    if (keep) {
      out[k] = v;
      continue;
    }
    out[k] = errorClass
      ? jest.fn(async () => {
          const Err = actual[errorClass] as new (status: number, message: string) => Error;
          throw new Err(401, "token rejected");
        })
      : jest.fn(async () => ({
          ok: false,
          code: "not_connected",
          status: 401,
          message: "microsoft_not_connected",
        }));
  }
  return out;
}

jest.mock("@/lib/integrations/microsoft-mail", () => mockNotConnectedModule("@/lib/integrations/microsoft-mail"));
jest.mock("@/lib/integrations/microsoft-calendar", () => mockNotConnectedModule("@/lib/integrations/microsoft-calendar"));
jest.mock("@/lib/integrations/microsoft-online-meetings", () =>
  mockNotConnectedModule("@/lib/integrations/microsoft-online-meetings"),
);
jest.mock("@/lib/integrations/microsoft-planner", () => mockNotConnectedModule("@/lib/integrations/microsoft-planner"));
jest.mock("@/lib/integrations/microsoft-groups", () => mockNotConnectedModule("@/lib/integrations/microsoft-groups"));
jest.mock("@/lib/integrations/microsoft-tasks", () =>
  mockNotConnectedModule("@/lib/integrations/microsoft-tasks", "GraphTasksError"),
);
jest.mock("@/lib/integrations/microsoft-contacts", () =>
  mockNotConnectedModule("@/lib/integrations/microsoft-contacts", "GraphContactsError"),
);
jest.mock("@/lib/integrations/microsoft-directory", () =>
  mockNotConnectedModule("@/lib/integrations/microsoft-directory", "DirectoryError"),
);
jest.mock("@/lib/integrations/microsoft-people", () =>
  mockNotConnectedModule("@/lib/integrations/microsoft-people", "GraphPeopleError"),
);
jest.mock("@/lib/integrations/microsoft-teams-chat", () =>
  mockNotConnectedModule("@/lib/integrations/microsoft-teams-chat", "TeamsChatError"),
);
jest.mock("@/lib/integrations/microsoft-channel-messages", () =>
  mockNotConnectedModule("@/lib/integrations/microsoft-channel-messages", "ChannelMessagesError"),
);
jest.mock("@/lib/integrations/microsoft-files", () =>
  mockNotConnectedModule("@/lib/integrations/microsoft-files", "GraphFilesError"),
);
jest.mock("@/lib/integrations/microsoft-onenote", () =>
  mockNotConnectedModule("@/lib/integrations/microsoft-onenote", "OneNoteError"),
);

type Handler = (req: NextRequest, ctx?: { params: Promise<Record<string, string>> }) => Promise<Response>;

interface Case {
  route: string;
  method: "GET" | "POST" | "PATCH" | "DELETE";
  load: () => Record<string, unknown>;
  query?: string;
  body?: unknown;
  form?: () => FormData;
  params?: Record<string, string>;
  /** Data key a read must still carry so a consumer renders an empty list. */
  emptyKey?: string;
  /** Per-case state the route reads before it reaches Graph. */
  setup?: () => void;
}

/** A cached To Do task row, so the task routes get past their 404 check and
 *  reach the Graph call. */
function withCachedTask(): void {
  const tasks = jest.requireMock("@/lib/integrations/microsoft-tasks") as Record<string, jest.Mock>;
  tasks.getCachedTaskById.mockResolvedValueOnce({ id: "t1", listId: "l1", msTaskId: "ms-t1", title: "t", status: "notStarted" });
  const db = jest.requireMock("@/lib/db") as Record<string, jest.Mock>;
  db.safeQuery.mockResolvedValueOnce({ rows: [{ ms_list_id: "ms-l1" }] });
  db.query.mockResolvedValueOnce({ rows: [{ ms_list_id: "ms-l1" }] });
}

const CASES: Case[] = [
  { route: "emails/inbox", method: "GET", load: () => require("../emails/inbox/route"), query: "?folder=inbox", emptyKey: "messages" },
  { route: "emails/messages/[id]", method: "PATCH", load: () => require("../emails/messages/[id]/route"), params: { id: "m1" }, body: { isRead: true } },
  { route: "emails/messages/[id]", method: "DELETE", load: () => require("../emails/messages/[id]/route"), params: { id: "m1" } },
  { route: "emails/messages/[id]/reply", method: "POST", load: () => require("../emails/messages/[id]/reply/route"), params: { id: "m1" }, body: { kind: "reply", bodyText: "hi" } },
  { route: "mail/[id]", method: "GET", load: () => require("../mail/[id]/route"), params: { id: "m1" }, emptyKey: "message" },
  { route: "mail/send", method: "POST", load: () => require("../mail/send/route"), body: { to: ["a@example.com"], subject: "s", bodyText: "b" } },
  { route: "mail/draft", method: "POST", load: () => require("../mail/draft/route"), body: { to: ["a@example.com"], subject: "s", bodyText: "b" } },
  { route: "mail/reply", method: "POST", load: () => require("../mail/reply/route"), body: { originalMessageId: "m1", bodyText: "b" } },
  { route: "calendar/events", method: "POST", load: () => require("../calendar/events/route"), body: { subject: "s", start: "2026-11-01T10:00:00Z", end: "2026-11-01T11:00:00Z" } },
  { route: "calendar/events/[id]", method: "PATCH", load: () => require("../calendar/events/[id]/route"), params: { id: "e1" }, body: { subject: "s" } },
  { route: "calendar/events/[id]", method: "DELETE", load: () => require("../calendar/events/[id]/route"), params: { id: "e1" }, query: "?confirm=true" },
  { route: "online-meetings", method: "POST", load: () => require("../online-meetings/route"), body: { subject: "s", startAt: "2026-11-01T10:00:00Z", endAt: "2026-11-01T11:00:00Z" } },
  { route: "online-meetings/[id]", method: "PATCH", load: () => require("../online-meetings/[id]/route"), params: { id: "o1" }, body: { subject: "s" } },
  { route: "planner/tasks", method: "POST", load: () => require("../planner/tasks/route"), body: { planId: "p1", title: "t" } },
  { route: "planner/tasks/[id]", method: "PATCH", load: () => require("../planner/tasks/[id]/route"), params: { id: "t1" }, body: { etag: "W/1", title: "t" } },
  { route: "planner/tasks/[id]/complete", method: "POST", load: () => require("../planner/tasks/[id]/complete/route"), params: { id: "t1" }, body: { etag: "W/1" } },
  { route: "planner/plans/[id]/buckets", method: "GET", load: () => require("../planner/plans/[id]/buckets/route"), params: { id: "p1" }, emptyKey: "buckets" },
  { route: "planner/plans/[id]/tasks", method: "GET", load: () => require("../planner/plans/[id]/tasks/route"), params: { id: "p1" }, emptyKey: "tasks" },
  { route: "planner/sync", method: "POST", load: () => require("../planner/sync/route") },
  { route: "groups/sync", method: "POST", load: () => require("../groups/sync/route") },
  { route: "tasks", method: "POST", load: () => require("../tasks/route"), body: { title: "t", listId: "l1" } },
  { route: "tasks/sync", method: "POST", load: () => require("../tasks/sync/route") },
  { route: "tasks/[id]", method: "PATCH", load: () => require("../tasks/[id]/route"), params: { id: "t1" }, body: { title: "t" }, setup: withCachedTask },
  { route: "tasks/[id]", method: "DELETE", load: () => require("../tasks/[id]/route"), params: { id: "t1" }, setup: withCachedTask },
  { route: "tasks/[id]/complete", method: "POST", load: () => require("../tasks/[id]/complete/route"), params: { id: "t1" }, setup: withCachedTask },
  { route: "contacts", method: "POST", load: () => require("../contacts/route"), body: { displayName: "D" } },
  { route: "contacts/sync", method: "POST", load: () => require("../contacts/sync/route") },
  { route: "contacts/[id]", method: "PATCH", load: () => require("../contacts/[id]/route"), params: { id: "c1" }, body: { displayName: "D" } },
  { route: "contacts/[id]", method: "DELETE", load: () => require("../contacts/[id]/route"), params: { id: "c1" } },
  { route: "directory/sync", method: "POST", load: () => require("../directory/sync/route") },
  { route: "people/suggest", method: "GET", load: () => require("../people/suggest/route"), query: "?q=al", emptyKey: "suggestions" },
  { route: "teams/sync", method: "POST", load: () => require("../teams/sync/route") },
  { route: "teams/channels-sync", method: "POST", load: () => require("../teams/channels-sync/route") },
  { route: "files", method: "GET", load: () => require("../files/route"), query: "?search=x", emptyKey: "items" },
  { route: "files/[id]", method: "GET", load: () => require("../files/[id]/route"), params: { id: "f1" }, emptyKey: "item" },
  { route: "files/[id]", method: "DELETE", load: () => require("../files/[id]/route"), params: { id: "f1" } },
  { route: "files/[id]/download-url", method: "GET", load: () => require("../files/[id]/download-url/route"), params: { id: "f1" }, emptyKey: "url" },
  { route: "files/[id]/share", method: "POST", load: () => require("../files/[id]/share/route"), params: { id: "f1" }, body: { type: "view", scope: "organization" } },
  { route: "files/upload-session", method: "POST", load: () => require("../files/upload-session/route"), body: { parentId: "root", filename: "a.txt" } },
  {
    route: "files/upload",
    method: "POST",
    load: () => require("../files/upload/route"),
    form: () => {
      const f = new FormData();
      f.append("file", new Blob(["hello"], { type: "text/plain" }), "a.txt");
      return f;
    },
  },
  { route: "onenote/notebooks", method: "GET", load: () => require("../onenote/notebooks/route"), emptyKey: "notebooks" },
  { route: "onenote/sections", method: "GET", load: () => require("../onenote/sections/route"), query: "?notebookId=n1", emptyKey: "sections" },
  { route: "onenote/pages", method: "POST", load: () => require("../onenote/pages/route"), body: { sectionId: "s1", title: "t", html: "<p>x</p>" } },
  { route: "onenote/pages/[id]", method: "GET", load: () => require("../onenote/pages/[id]/route"), params: { id: "pg1" }, emptyKey: "html" },
  { route: "onenote/sync", method: "POST", load: () => require("../onenote/sync/route") },
];

function buildRequest(c: Case, withSession: boolean): NextRequest {
  const headers: Record<string, string> = {};
  if (withSession) headers.authorization = "Bearer session-token";
  let body: BodyInit | undefined;
  if (c.form) body = c.form();
  else if (c.body !== undefined || c.method !== "GET") {
    headers["content-type"] = "application/json";
    body = JSON.stringify(c.body ?? {});
  }
  const path = c.route.replace(/\[(\w+)\]/g, (_, k: string) => c.params?.[k] ?? k);
  return new NextRequest(`https://x.test/api/${path}${c.query ?? ""}`, {
    method: c.method,
    headers,
    body: c.method === "GET" ? undefined : body,
  });
}

async function call(c: Case, withSession: boolean): Promise<Response> {
  const mod = c.load();
  // Sync routes allow one run per user per window; each assertion is a fresh run.
  for (const [k, v] of Object.entries(mod)) {
    if (k.startsWith("_reset") && typeof v === "function") (v as () => void)();
  }
  if (withSession) c.setup?.();
  const handler = mod[c.method] as Handler | undefined;
  if (!handler) throw new Error(`${c.route} has no ${c.method} handler`);
  const ctx = { params: Promise.resolve(c.params ?? {}) };
  return handler(buildRequest(c, withSession), ctx);
}

beforeEach(() => {
  mockGetUser.mockReset();
  mockTrackEvent.mockReset();
  mockGetUser.mockReturnValue({ id: "u1", role: "ceo", email: "u1@example.com", name: "U", workspaceId: "default" });
});

describe.each(CASES)("$method /api/$route with no Microsoft connection", (c) => {
  const read = c.method === "GET";

  it(read ? "answers 200 { connected: false } (never 401)" : "answers 409 { connected: false } (never 401)", async () => {
    const res = await call(c, true);
    const body = await res.json();
    expect({ status: res.status, body }).toMatchObject({
      status: read ? 200 : 409,
      body: { connected: false, provider: "microsoft", error: "microsoft_not_connected" },
    });
    expect(typeof body.notice).toBe("string");
    if (c.emptyKey) expect(body).toHaveProperty(c.emptyKey);
  });

  it("records integration.not_connected_served", async () => {
    await call(c, true);
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "integration.not_connected_served",
      "u1",
      "ceo",
      expect.objectContaining({ provider: "microsoft", method: c.method }),
    );
  });

  it("still answers 401 when there is no Instinct session", async () => {
    mockGetUser.mockReturnValue(null);
    const res = await call(c, false);
    expect(res.status).toBe(401);
  });
});
