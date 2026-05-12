/**
 * /api/teams/teams + nested routes + channels-sync route tests.
 */
 

export {};

const mockGetUserTC = jest.fn();
jest.mock("@/lib/auth", () => ({
  getUserFromRequest: (...args: unknown[]) => mockGetUserTC(...args),
}));

const mockTrackTC = jest.fn();
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...args: unknown[]) => mockTrackTC(...args),
}));

const mockListCachedTeamsTC = jest.fn();
const mockGetCachedTeamByIdTC = jest.fn();
const mockListCachedChannelsTC = jest.fn();
const mockGetCachedChannelByIdTC = jest.fn();
const mockListCachedChannelMessagesTC = jest.fn();
const mockSyncAllChannelsTC = jest.fn();
const mockAsScopeMissingTC = jest.fn();

class FakeChannelMessagesError extends Error {
  status: number;
  retryAfter?: number;
  constructor(status: number, msg: string, retryAfter?: number) {
    super(msg);
    this.name = "ChannelMessagesError";
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

jest.mock("@/lib/integrations/microsoft-channel-messages", () => ({
  listCachedTeams: (...args: unknown[]) => mockListCachedTeamsTC(...args),
  getCachedTeamById: (...args: unknown[]) => mockGetCachedTeamByIdTC(...args),
  listCachedChannels: (...args: unknown[]) => mockListCachedChannelsTC(...args),
  getCachedChannelById: (...args: unknown[]) =>
    mockGetCachedChannelByIdTC(...args),
  listCachedChannelMessages: (...args: unknown[]) =>
    mockListCachedChannelMessagesTC(...args),
  syncAllChannels: (...args: unknown[]) => mockSyncAllChannelsTC(...args),
  asScopeMissing: (...args: unknown[]) => mockAsScopeMissingTC(...args),
  ChannelMessagesError: FakeChannelMessagesError,
}));

jest.mock("@/lib/db", () => ({
  safeQuery: jest.fn(),
  query: jest.fn(),
}));

import { GET as teamsGET } from "@/app/api/teams/teams/route";
import { GET as channelsGET } from "@/app/api/teams/teams/[id]/channels/route";
import { GET as messagesGET } from "@/app/api/teams/teams/[id]/channels/[channelId]/messages/route";
import { POST as repliesPOST } from "@/app/api/teams/teams/[id]/channels/[channelId]/messages/[messageId]/replies/route";
import {
  POST as syncPOST,
  _resetRateLimit as resetChannelSyncRate,
} from "@/app/api/teams/channels-sync/route";

function mkReq(auth?: string, body?: any, search?: string): any {
  return {
    headers: {
      get: (k: string) => {
        if (k.toLowerCase() === "authorization") return auth ?? null;
        if (k.toLowerCase() === "content-length")
          return body ? String(JSON.stringify(body).length) : "0";
        return null;
      },
    },
    json: () => Promise.resolve(body ?? {}),
    url: `http://localhost/x${search ?? ""}`,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  resetChannelSyncRate();
  mockGetUserTC.mockReturnValue({ id: "u-1", role: "admin" });
});

// ---------------------------------------------------------------------------
// GET /api/teams/teams
// ---------------------------------------------------------------------------

describe("GET /api/teams/teams", () => {
  it("401s with no auth", async () => {
    mockGetUserTC.mockReturnValueOnce(null);
    const res = await teamsGET(mkReq());
    expect(res.status).toBe(401);
  });

  it("returns cached teams", async () => {
    mockListCachedTeamsTC.mockResolvedValueOnce([
      { id: "t-loc-1", displayName: "Eng" },
    ]);
    const res = await teamsGET(mkReq("Bearer x"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.teams).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// GET /api/teams/teams/[id]/channels
// ---------------------------------------------------------------------------

describe("GET /api/teams/teams/[id]/channels", () => {
  it("404s when team not cached", async () => {
    mockGetCachedTeamByIdTC.mockResolvedValueOnce(null);
    const res = await channelsGET(mkReq("Bearer x"), {
      params: Promise.resolve({ id: "t-loc-1" }),
    });
    expect(res.status).toBe(404);
  });

  it("returns channels for cached team", async () => {
    mockGetCachedTeamByIdTC.mockResolvedValueOnce({
      id: "t-loc-1",
      displayName: "Eng",
    });
    mockListCachedChannelsTC.mockResolvedValueOnce([{ id: "c-1" }]);
    const res = await channelsGET(mkReq("Bearer x"), {
      params: Promise.resolve({ id: "t-loc-1" }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.channels).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// GET messages — filters forwarded
// ---------------------------------------------------------------------------

describe("GET messages route", () => {
  it("forwards search / cursor / since / mentioned=me filters", async () => {
    mockGetCachedTeamByIdTC.mockResolvedValueOnce({ id: "t-1" });
    mockGetCachedChannelByIdTC.mockResolvedValueOnce({ id: "c-1", teamId: "t-1" });
    mockListCachedChannelMessagesTC.mockResolvedValueOnce({
      messages: [],
      nextCursor: null,
    });
    const res = await messagesGET(
      mkReq("Bearer x", undefined, "?search=kickoff&since=2026-04-01&mentioned=me&limit=25"),
      { params: Promise.resolve({ id: "t-1", channelId: "c-1" }) },
    );
    expect(res.status).toBe(200);
    expect(mockListCachedChannelMessagesTC).toHaveBeenCalledWith(
      "u-1",
      "c-1",
      expect.objectContaining({
        search: "kickoff",
        since: "2026-04-01",
        limit: 25,
        mentionedUserId: "u-1",
      }),
    );
  });

  it("404s when channel not in team", async () => {
    mockGetCachedTeamByIdTC.mockResolvedValueOnce({ id: "t-1" });
    mockGetCachedChannelByIdTC.mockResolvedValueOnce({ id: "c-1", teamId: "t-other" });
    const res = await messagesGET(mkReq("Bearer x"), {
      params: Promise.resolve({ id: "t-1", channelId: "c-1" }),
    });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Replies POST 501 scope not granted
// ---------------------------------------------------------------------------

describe("POST replies route — 501", () => {
  it("always returns 501 scope_not_granted and fires capability_denied", async () => {
    const res = await repliesPOST(mkReq("Bearer x"), {
      params: Promise.resolve({ id: "t-1", channelId: "c-1", messageId: "m-1" }),
    });
    expect(res.status).toBe(501);
    const body = await res.json();
    expect(body.code).toBe("scope_not_granted");
    expect(mockTrackTC).toHaveBeenCalledWith(
      "system.capability_denied",
      "u-1",
      "admin",
      expect.objectContaining({ endpoint: "teams.channel.reply" }),
    );
  });
});

// ---------------------------------------------------------------------------
// POST /api/teams/channels-sync — rate limit + scope_missing + success
// ---------------------------------------------------------------------------

describe("POST /api/teams/channels-sync", () => {
  it("rate-limits second call within 5 min", async () => {
    mockSyncAllChannelsTC.mockResolvedValueOnce({
      teamCount: 1,
      channelCount: 1,
      messageCount: 0,
      durationMs: 1,
    });
    const first = await syncPOST(mkReq("Bearer x"));
    expect(first.status).toBe(200);
    const second = await syncPOST(mkReq("Bearer x"));
    expect(second.status).toBe(429);
  });

  it("returns 403 scope_missing when asScopeMissing hits", async () => {
    resetChannelSyncRate();
    mockAsScopeMissingTC.mockReturnValueOnce({
      ok: false,
      code: "scope_missing",
      scope: "ChannelMessage.Read.All",
    });
    mockSyncAllChannelsTC.mockRejectedValueOnce(
      new FakeChannelMessagesError(403, "forbidden"),
    );
    const res = await syncPOST(mkReq("Bearer x"));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("scope_missing");
  });

  it("returns 502 on non-429 non-403 graph error", async () => {
    resetChannelSyncRate();
    mockAsScopeMissingTC.mockReturnValueOnce(null);
    mockSyncAllChannelsTC.mockRejectedValueOnce(
      new FakeChannelMessagesError(500, "internal"),
    );
    const res = await syncPOST(mkReq("Bearer x"));
    expect(res.status).toBe(502);
  });
});
