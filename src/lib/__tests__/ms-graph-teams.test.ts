/**
 * Unit tests for src/lib/ms-graph-teams.ts. Covers:
 *   - happy-path normalization for teams / channels / messages
 *   - 401/403 → scope_missing
 *   - HTML body strip + bodyText projection on channel messages
 *   - Graph URL composition (top, encoding)
 */
 
export {};

const mockTrack = jest.fn();
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: any[]) => mockTrack(...a) }));

const fetchMock = jest.fn();
beforeEach(() => {
  fetchMock.mockReset();
  mockTrack.mockReset();
  global.fetch = fetchMock as any;
});

function mkOk(body: any) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}
function mkStatus(status: number, body: any = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

describe("listJoinedTeams", () => {
  it("returns normalized teams on 200", async () => {
    fetchMock.mockResolvedValue(
      mkOk({
        value: [
          { id: "t1", displayName: "Wolfpack" },
          { id: "t2", displayName: "CFTR", description: "Client" },
          { id: null }, // dropped
        ],
      }),
    );
    const { listJoinedTeams } = await import("@/lib/ms-graph-teams");
    const result = await listJoinedTeams("token");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.teams).toHaveLength(2);
      expect(result.teams[1].description).toBe("Client");
    }
    expect(mockTrack).toHaveBeenCalledWith(
      "ms_teams.listed",
      "system",
      "system",
      { count: 2 },
    );
  });

  it("returns scope_missing on 403", async () => {
    fetchMock.mockResolvedValue(mkStatus(403));
    const { listJoinedTeams } = await import("@/lib/ms-graph-teams");
    const result = await listJoinedTeams("token", 50, "user-1");
    expect(result.ok).toBe(false);
    if (!result.ok && result.code === "scope_missing") {
      expect(result.scope).toBe("Team.ReadBasic.All");
    }
    expect(mockTrack).toHaveBeenCalledWith(
      "ms_teams.scope_missing",
      "user-1",
      "system",
      { surface: "list_teams" },
    );
  });

  it("returns error (not empty teams) on non-200/401/403 status", async () => {
    // Regression: Nick saw the LEFT panel show a blank Teams section
    // when Graph returned an unexpected status (e.g. 400 from a token
    // missing the new scopes). The helper used to silently coerce
    // any non-200 into "user has 0 teams" — now it surfaces the real
    // status so the UI can show "couldn't load Teams" with the HTTP
    // code, not a misleading empty state.
    fetchMock.mockResolvedValue(mkStatus(400));
    const { listJoinedTeams } = await import("@/lib/ms-graph-teams");
    const result = await listJoinedTeams("token");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("error");
      if (result.code === "error") expect(result.status).toBe(400);
    }
  });

  it("parses Graph's error envelope and surfaces graphCode + graphMessage", async () => {
    // After Nick reconnected MS twice and still got 400, we needed
    // the actual reason. Graph errors carry { error: { code, message } }
    // — surface both so the UI can show "BadRequest · Insufficient
    // privileges to complete the operation." instead of just "400".
    fetchMock.mockResolvedValue(
      mkStatus(400, {
        error: {
          code: "BadRequest",
          message: "Insufficient privileges to complete the operation.",
        },
      }),
    );
    const { listJoinedTeams } = await import("@/lib/ms-graph-teams");
    const result = await listJoinedTeams("token");
    expect(result.ok).toBe(false);
    if (!result.ok && result.code === "error") {
      expect(result.graphCode).toBe("BadRequest");
      expect(result.graphMessage).toMatch(/Insufficient privileges/);
    }
  });

  it("does NOT send $top to /me/joinedTeams (Graph rejects it)", async () => {
    // Regression: Nick saw "The query specified in the URI is not
    // valid. Query option 'Top' is not allowed." from Graph. The
    // /me/joinedTeams endpoint specifically rejects $top — unlike
    // most Graph endpoints. Code now omits the parameter entirely.
    fetchMock.mockResolvedValue(mkOk({ value: [] }));
    const { listJoinedTeams } = await import("@/lib/ms-graph-teams");
    await listJoinedTeams("token", 50);
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).not.toContain("$top");
    expect(url).toMatch(/\/me\/joinedTeams$/);
  });

  it("client-side slices the result to honor the caller's limit", async () => {
    // Since Graph returns all teams unconditionally, the helper has
    // to slice locally to keep the response bounded for callers that
    // pass a small limit.
    fetchMock.mockResolvedValue(
      mkOk({
        value: Array.from({ length: 12 }, (_, i) => ({
          id: `t${i}`,
          displayName: `Team ${i}`,
        })),
      }),
    );
    const { listJoinedTeams } = await import("@/lib/ms-graph-teams");
    const result = await listJoinedTeams("token", 5);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.teams).toHaveLength(5);
  });
});

describe("listTeamChannels", () => {
  it("returns normalized channels and includes teamId in analytics", async () => {
    fetchMock.mockResolvedValue(
      mkOk({
        value: [
          { id: "c1", displayName: "General", membershipType: "standard" },
          { id: "c2", displayName: "Eng" },
        ],
      }),
    );
    const { listTeamChannels } = await import("@/lib/ms-graph-teams");
    const result = await listTeamChannels("token", "team-99");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.channels).toHaveLength(2);
    expect(mockTrack).toHaveBeenCalledWith(
      "ms_teams.channels_listed",
      "system",
      "system",
      { team_id: "team-99", count: 2 },
    );
  });

  it("encodes the teamId into the URL", async () => {
    fetchMock.mockResolvedValue(mkOk({ value: [] }));
    const { listTeamChannels } = await import("@/lib/ms-graph-teams");
    await listTeamChannels("token", "weird/team:id");
    expect(fetchMock.mock.calls[0][0]).toContain(
      "/teams/weird%2Fteam%3Aid/channels",
    );
  });

  it("scope_missing on 401", async () => {
    fetchMock.mockResolvedValue(mkStatus(401));
    const { listTeamChannels } = await import("@/lib/ms-graph-teams");
    const result = await listTeamChannels("token", "t");
    expect(result.ok).toBe(false);
  });
});

describe("listChannelMessages", () => {
  it("strips HTML and projects bodyText", async () => {
    fetchMock.mockResolvedValue(
      mkOk({
        value: [
          {
            id: "m1",
            createdDateTime: "2026-04-23T10:00:00Z",
            body: { contentType: "html", content: "<p>hello <b>team</b></p>" },
            from: { user: { id: "u-x", displayName: "Max" } },
          },
        ],
      }),
    );
    const { listChannelMessages } = await import("@/lib/ms-graph-teams");
    const result = await listChannelMessages("token", "t", "c");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.messages[0].bodyText).toBe("hello team");
      expect(result.messages[0].from?.displayName).toBe("Max");
    }
  });

  it("scope_missing on 403", async () => {
    fetchMock.mockResolvedValue(mkStatus(403));
    const { listChannelMessages } = await import("@/lib/ms-graph-teams");
    const result = await listChannelMessages("token", "t", "c");
    expect(result.ok).toBe(false);
    if (!result.ok && result.code === "scope_missing")
      expect(result.scope).toBe("ChannelMessage.Read.All");
  });
});

describe("sendChannelMessage", () => {
  it("POSTs the right body shape and returns the normalized server message", async () => {
    fetchMock.mockResolvedValue(
      mkOk({
        id: "srv-99",
        createdDateTime: "2026-04-24T10:00:00Z",
        body: { contentType: "text", content: "hi team" },
        from: { user: { id: "u-x", displayName: "Nick" } },
      }),
    );
    const { sendChannelMessage } = await import("@/lib/ms-graph-teams");
    const result = await sendChannelMessage("token", "t1", "c1", "hi team", "user-1");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.message.id).toBe("srv-99");
      expect(result.message.bodyText).toBe("hi team");
    }
    // Outgoing request shape: POST + JSON body with body.content.
    const call = fetchMock.mock.calls[0];
    expect(call[0]).toContain("/teams/t1/channels/c1/messages");
    expect(call[1].method).toBe("POST");
    const sent = JSON.parse(call[1].body);
    expect(sent.body.contentType).toBe("text");
    expect(sent.body.content).toBe("hi team");
    // Analytics fired with length.
    expect(mockTrack).toHaveBeenCalledWith(
      "ms_teams.channel_message_sent",
      "user-1",
      "system",
      { team_id: "t1", channel_id: "c1", length: 7 },
    );
  });

  it("scope_missing on 403", async () => {
    fetchMock.mockResolvedValue(mkStatus(403));
    const { sendChannelMessage } = await import("@/lib/ms-graph-teams");
    const result = await sendChannelMessage("token", "t", "c", "hi");
    expect(result.ok).toBe(false);
    if (!result.ok && result.code === "scope_missing")
      expect(result.scope).toBe("ChannelMessage.Send");
  });

  it("graph error parses code + message from body", async () => {
    fetchMock.mockResolvedValue(
      mkStatus(400, { error: { code: "BadRequest", message: "Channel not found" } }),
    );
    const { sendChannelMessage } = await import("@/lib/ms-graph-teams");
    const result = await sendChannelMessage("token", "t", "c", "hi");
    expect(result.ok).toBe(false);
    if (!result.ok && result.code === "error") {
      expect(result.graphCode).toBe("BadRequest");
      expect(result.graphMessage).toMatch(/Channel not found/);
    }
  });
});
