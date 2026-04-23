/**
 * Unit tests for src/lib/ms-graph-teams.ts. Covers:
 *   - happy-path normalization for teams / channels / messages
 *   - 401/403 → scope_missing
 *   - HTML body strip + bodyText projection on channel messages
 *   - Graph URL composition (top, encoding)
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
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
    if (!result.ok) {
      expect(result.code).toBe("scope_missing");
      expect(result.scope).toBe("Team.ReadBasic.All");
    }
    expect(mockTrack).toHaveBeenCalledWith(
      "ms_teams.scope_missing",
      "user-1",
      "system",
      { surface: "list_teams" },
    );
  });

  it("clamps limit to 1..100", async () => {
    fetchMock.mockResolvedValue(mkOk({ value: [] }));
    const { listJoinedTeams } = await import("@/lib/ms-graph-teams");
    await listJoinedTeams("token", 999);
    const url = fetchMock.mock.calls[0][0];
    expect(url).toContain("$top=100");
    fetchMock.mockClear();
    await listJoinedTeams("token", -5);
    // Negative values clamp to the floor (1), not the default —
    // either way we never send Graph an out-of-range $top.
    expect(fetchMock.mock.calls[0][0]).toContain("$top=1");
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
    if (!result.ok) expect(result.scope).toBe("ChannelMessage.Read.All");
  });
});
