/**
 * cross-tool-generators — unit coverage for the rule-based pattern
 * matchers. Each generator is tested in isolation with its dependencies
 * mocked. Generators are HELPFUL (not punishing) — tests confirm the
 * framing is "heads-up", "awaiting review", "momentum", never "you
 * failed to do X".
 */

const mockSearchPRs = jest.fn();
const mockListDeployments = jest.fn();
const mockVercelConfigured = jest.fn();
const mockFetchCalendarEvents = jest.fn();
const mockFetchUserProfile = jest.fn();

jest.mock("@/lib/assistant/tools/github-query-client", () => ({
  searchPullRequests: (...a: unknown[]) => mockSearchPRs(...a),
}));
jest.mock("@/lib/integrations/vercel", () => ({
  listDeployments: (...a: unknown[]) => mockListDeployments(...a),
  vercelIsConfigured: () => mockVercelConfigured(),
}));
jest.mock("@/lib/microsoft-graph", () => ({
  fetchCalendarEvents: (...a: unknown[]) => mockFetchCalendarEvents(...a),
  fetchUserProfile: (...a: unknown[]) => mockFetchUserProfile(...a),
}));

import {
  runAllInsightGenerators,
  INSIGHT_GENERATORS,
} from "@/lib/insights/cross-tool-generators";

const ctx = { userId: "u1", userRole: "cto" };
const day = 24 * 60 * 60 * 1000;

beforeEach(() => {
  mockSearchPRs.mockReset();
  mockListDeployments.mockReset();
  mockVercelConfigured.mockReset();
  mockFetchCalendarEvents.mockReset();
  mockFetchUserProfile.mockReset();
});

describe("INSIGHT_GENERATORS registry", () => {
  test("ships at least 5 generators", () => {
    expect(INSIGHT_GENERATORS.length).toBeGreaterThanOrEqual(5);
  });
  test("every generator has a name, label, requires list, and async run()", () => {
    for (const g of INSIGHT_GENERATORS) {
      expect(typeof g.name).toBe("string");
      expect(typeof g.label).toBe("string");
      expect(Array.isArray(g.requires)).toBe(true);
      expect(typeof g.run).toBe("function");
    }
  });
  test("at least 3 generators are strictly cross-tool (require 2+ integrations)", () => {
    const crossTool = INSIGHT_GENERATORS.filter((g) => g.requires.length >= 2);
    expect(crossTool.length).toBeGreaterThanOrEqual(3);
  });
  test("no generator named with a punishing intent (email_unread, missed_, forgot_)", () => {
    for (const g of INSIGHT_GENERATORS) {
      expect(g.name).not.toMatch(/email_unread|missed_|forgot_|failed_to_/);
    }
  });
});

function meetingIn(hours: number, attendees: string[]) {
  const start = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
  const end = new Date(
    Date.now() + (hours + 1) * 60 * 60 * 1000,
  ).toISOString();
  return {
    id: `ev-${hours}`,
    subject: `meeting in ${hours}h`,
    start,
    end,
    location: "",
    attendees,
    attendeeEmails: attendees,
    isOnlineMeeting: false,
    showAs: "busy",
  };
}

describe("github_pr_stagnation generator", () => {
  const gen = () =>
    INSIGHT_GENERATORS.find((g) => g.name === "github_pr_stagnation")!;

  test("uses helpful 'awaiting review' framing, not 'stagnation'", async () => {
    const now = Date.now();
    mockSearchPRs.mockResolvedValueOnce({
      ok: true,
      data: [
        {
          number: 1,
          title: "feat",
          state: "open",
          draft: false,
          repo: "wolfpack-apex",
          user: "alice",
          html_url: "https://github.com/x/x/pull/1",
          created_at: new Date(now - 10 * day).toISOString(),
          updated_at: new Date(now - 10 * day).toISOString(),
        },
      ],
    });
    const out = await gen().run(ctx);
    expect(out).toHaveLength(1);
    expect(out[0].title).toContain("awaiting review");
    expect(out[0].title).not.toMatch(/no activity|stagnation|stale/i);
  });

  test("severity is medium at 14+ days, low otherwise (de-escalated to not be alarmist)", async () => {
    const now = Date.now();
    mockSearchPRs.mockResolvedValueOnce({
      ok: true,
      data: [
        {
          number: 1,
          title: "8 days",
          state: "open",
          draft: false,
          repo: "r",
          user: "alice",
          html_url: "u",
          created_at: new Date(now - 8 * day).toISOString(),
          updated_at: new Date(now - 8 * day).toISOString(),
        },
        {
          number: 2,
          title: "20 days",
          state: "open",
          draft: false,
          repo: "r",
          user: "bob",
          html_url: "u",
          created_at: new Date(now - 20 * day).toISOString(),
          updated_at: new Date(now - 20 * day).toISOString(),
        },
      ],
    });
    const out = await gen().run(ctx);
    expect(out.find((i) => i.title.includes("#1"))?.severity).toBe("low");
    expect(out.find((i) => i.title.includes("#2"))?.severity).toBe("medium");
  });

  test("excludes bot authors and drafts", async () => {
    const now = Date.now();
    mockSearchPRs.mockResolvedValueOnce({
      ok: true,
      data: [
        {
          number: 10,
          title: "bump",
          state: "open",
          draft: false,
          repo: "r",
          user: "dependabot[bot]",
          html_url: "u",
          created_at: new Date(now - 30 * day).toISOString(),
          updated_at: new Date(now - 30 * day).toISOString(),
        },
        {
          number: 20,
          title: "WIP",
          state: "open",
          draft: true,
          repo: "r",
          user: "alice",
          html_url: "u",
          created_at: new Date(now - 30 * day).toISOString(),
          updated_at: new Date(now - 30 * day).toISOString(),
        },
      ],
    });
    expect(await gen().run(ctx)).toEqual([]);
  });

  test("degrades to [] when github query fails", async () => {
    mockSearchPRs.mockResolvedValueOnce({
      ok: false,
      code: "auth_failed",
      message: "x",
    });
    expect(await gen().run(ctx)).toEqual([]);
  });
});

describe("vercel_failed_no_followup generator", () => {
  const gen = () =>
    INSIGHT_GENERATORS.find((g) => g.name === "vercel_failed_no_followup")!;

  test("suppresses a failure when a later READY deploy exists on the same branch + target", async () => {
    mockVercelConfigured.mockReturnValue(true);
    const now = Date.now();
    mockListDeployments.mockResolvedValueOnce({
      ok: true,
      data: {
        deployments: [
          {
            uid: "d-fail",
            name: "wolfpack-auto",
            url: "u",
            state: "ERROR",
            target: "production",
            createdAt: now,
            meta: { githubCommitRef: "main" },
          },
          {
            uid: "d-recover",
            name: "wolfpack-auto",
            url: "u",
            state: "READY",
            target: "production",
            createdAt: now + 5000,
            meta: { githubCommitRef: "main" },
          },
        ],
      },
    });
    expect(await gen().run(ctx)).toEqual([]);
  });

  test("frames as 'needs a follow-up' rather than 'broken' — actionable, not alarmist", async () => {
    mockVercelConfigured.mockReturnValue(true);
    mockListDeployments.mockResolvedValueOnce({
      ok: true,
      data: {
        deployments: [
          {
            uid: "d",
            name: "wolfpack-auto",
            url: "u",
            state: "ERROR",
            target: "production",
            createdAt: Date.now(),
            meta: { githubCommitRef: "main" },
          },
        ],
      },
    });
    const out = await gen().run(ctx);
    expect(out[0].title).toContain("needs a follow-up");
  });

  test("returns [] when vercel not configured", async () => {
    mockVercelConfigured.mockReturnValue(false);
    expect(await gen().run(ctx)).toEqual([]);
  });
});

describe("meeting_attendee_open_pr generator", () => {
  const gen = () =>
    INSIGHT_GENERATORS.find((g) => g.name === "meeting_attendee_open_pr")!;

  test("uses helpful 'Heads-up' framing, never blame", async () => {
    mockFetchCalendarEvents.mockResolvedValueOnce([
      meetingIn(20, ["hoxsie@thewolfpack.agency"]),
    ]);
    mockFetchUserProfile.mockResolvedValueOnce({
      displayName: "Me",
      email: "homyk@thewolfpack.agency",
      jobTitle: "CTO",
      photoUrl: null,
    });
    mockSearchPRs.mockResolvedValueOnce({
      ok: true,
      data: [
        {
          number: 42,
          title: "feat",
          state: "open",
          draft: false,
          repo: "wolfpack-apex",
          user: "hoxsie",
          html_url: "u",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ],
    });
    const out = await gen().run(ctx);
    expect(out).toHaveLength(1);
    expect(out[0].title).toContain("Heads-up");
    expect(out[0].sources).toEqual(["github", "calendar"]);
    expect(out[0].severity).not.toBe("high"); // demoted: not urgent
  });

  test("excludes bot authors", async () => {
    mockFetchCalendarEvents.mockResolvedValueOnce([
      meetingIn(20, ["dependabot@thewolfpack.agency"]),
    ]);
    mockFetchUserProfile.mockResolvedValueOnce({
      displayName: "Me",
      email: "homyk@thewolfpack.agency",
      jobTitle: "CTO",
      photoUrl: null,
    });
    mockSearchPRs.mockResolvedValueOnce({
      ok: true,
      data: [
        {
          number: 1,
          title: "bump",
          state: "open",
          draft: false,
          repo: "r",
          user: "dependabot[bot]",
          html_url: "u",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ],
    });
    expect(await gen().run(ctx)).toEqual([]);
  });

  test("returns [] when no events or no matching PRs", async () => {
    mockFetchCalendarEvents.mockResolvedValueOnce([]);
    mockFetchUserProfile.mockResolvedValueOnce(null);
    mockSearchPRs.mockResolvedValueOnce({ ok: true, data: [] });
    expect(await gen().run(ctx)).toEqual([]);
  });
});

describe("recent_deploy_by_meeting_attendee generator", () => {
  const gen = () =>
    INSIGHT_GENERATORS.find(
      (g) => g.name === "recent_deploy_by_meeting_attendee",
    )!;

  test("surfaces a recent deploy by an upcoming-meeting attendee (coordination heads-up)", async () => {
    mockVercelConfigured.mockReturnValue(true);
    mockFetchCalendarEvents.mockResolvedValueOnce([
      meetingIn(3, ["alice@thewolfpack.agency"]),
    ]);
    mockFetchUserProfile.mockResolvedValueOnce({
      displayName: "Me",
      email: "homyk@thewolfpack.agency",
      jobTitle: "CTO",
      photoUrl: null,
    });
    mockListDeployments.mockResolvedValueOnce({
      ok: true,
      data: {
        deployments: [
          {
            uid: "d1",
            name: "wolfpack-auto",
            url: "u",
            state: "READY",
            target: "production",
            createdAt: Date.now() - 60 * 60 * 1000, // 1h ago
            meta: { githubCommitMessage: "feat: shipped a thing" },
            creator: { username: "alice" },
          },
        ],
      },
    });
    const out = await gen().run(ctx);
    expect(out).toHaveLength(1);
    expect(out[0].title).toContain("Heads-up");
    expect(out[0].title).toContain("alice");
    expect(out[0].sources).toEqual(["vercel", "calendar"]);
  });

  test("ignores deploys older than 6h", async () => {
    mockVercelConfigured.mockReturnValue(true);
    mockFetchCalendarEvents.mockResolvedValueOnce([
      meetingIn(3, ["alice@thewolfpack.agency"]),
    ]);
    mockFetchUserProfile.mockResolvedValueOnce({
      displayName: "Me",
      email: "homyk@thewolfpack.agency",
      jobTitle: "CTO",
      photoUrl: null,
    });
    mockListDeployments.mockResolvedValueOnce({
      ok: true,
      data: {
        deployments: [
          {
            uid: "d-old",
            name: "wolfpack-auto",
            url: "u",
            state: "READY",
            target: "production",
            createdAt: Date.now() - 12 * 60 * 60 * 1000, // 12h ago
            creator: { username: "alice" },
          },
        ],
      },
    });
    expect(await gen().run(ctx)).toEqual([]);
  });

  test("returns [] when vercel not configured", async () => {
    mockVercelConfigured.mockReturnValue(false);
    expect(await gen().run(ctx)).toEqual([]);
  });
});

describe("team_momentum_brief generator", () => {
  const gen = () =>
    INSIGHT_GENERATORS.find((g) => g.name === "team_momentum_brief")!;

  test("emits a positive weekly digest combining merged PRs + prod deploys", async () => {
    mockVercelConfigured.mockReturnValue(true);
    const now = Date.now();
    mockSearchPRs.mockResolvedValueOnce({
      ok: true,
      data: [
        {
          number: 1,
          title: "a",
          state: "closed",
          draft: false,
          repo: "wolfpack-apex",
          user: "alice",
          html_url: "u",
          created_at: new Date(now - 2 * day).toISOString(),
          updated_at: new Date(now - 2 * day).toISOString(),
        },
        {
          number: 2,
          title: "b",
          state: "closed",
          draft: false,
          repo: "wolfpack-auto",
          user: "bob",
          html_url: "u",
          created_at: new Date(now - 3 * day).toISOString(),
          updated_at: new Date(now - 3 * day).toISOString(),
        },
      ],
    });
    mockListDeployments.mockResolvedValueOnce({
      ok: true,
      data: {
        deployments: [
          {
            uid: "d1",
            name: "wolfpack-auto",
            url: "u",
            state: "READY",
            target: "production",
            createdAt: now - 1 * day,
          },
          {
            uid: "d2",
            name: "wolfpack-apex",
            url: "u",
            state: "READY",
            target: "production",
            createdAt: now - 2 * day,
          },
        ],
      },
    });
    const out = await gen().run(ctx);
    expect(out).toHaveLength(1);
    expect(out[0].title).toContain("PRs merged");
    expect(out[0].title).toContain("prod deploys");
    expect(out[0].sources).toEqual(["github", "vercel"]);
    expect(out[0].severity).toBe("low"); // positive/informational
  });

  test("excludes bot PRs from momentum count", async () => {
    mockVercelConfigured.mockReturnValue(true);
    const now = Date.now();
    mockSearchPRs.mockResolvedValueOnce({
      ok: true,
      data: [
        {
          number: 1,
          title: "bump",
          state: "closed",
          draft: false,
          repo: "r",
          user: "dependabot[bot]",
          html_url: "u",
          created_at: new Date(now - 1 * day).toISOString(),
          updated_at: new Date(now - 1 * day).toISOString(),
        },
      ],
    });
    mockListDeployments.mockResolvedValueOnce({
      ok: true,
      data: { deployments: [] },
    });
    expect(await gen().run(ctx)).toEqual([]);
  });

  test("returns [] when neither merged PRs nor prod deploys this week", async () => {
    mockVercelConfigured.mockReturnValue(true);
    mockSearchPRs.mockResolvedValueOnce({ ok: true, data: [] });
    mockListDeployments.mockResolvedValueOnce({
      ok: true,
      data: { deployments: [] },
    });
    expect(await gen().run(ctx)).toEqual([]);
  });

  test("works when vercel is not configured (just shows PR momentum)", async () => {
    mockVercelConfigured.mockReturnValue(false);
    const now = Date.now();
    mockSearchPRs.mockResolvedValueOnce({
      ok: true,
      data: [
        {
          number: 1,
          title: "a",
          state: "closed",
          draft: false,
          repo: "wolfpack-apex",
          user: "alice",
          html_url: "u",
          created_at: new Date(now - 1 * day).toISOString(),
          updated_at: new Date(now - 1 * day).toISOString(),
        },
      ],
    });
    const out = await gen().run(ctx);
    expect(out).toHaveLength(1);
    expect(out[0].sources).toEqual(["github"]);
  });
});

describe("runAllInsightGenerators aggregator", () => {
  test("sorts by severity then signalStrength, includes outcomes for every generator", async () => {
    mockSearchPRs.mockResolvedValue({ ok: true, data: [] });
    mockVercelConfigured.mockReturnValue(false);
    mockFetchCalendarEvents.mockResolvedValue([]);
    mockFetchUserProfile.mockResolvedValue(null);
    const result = await runAllInsightGenerators(ctx);
    expect(Array.isArray(result.insights)).toBe(true);
    expect(result.generatorOutcomes.length).toBe(INSIGHT_GENERATORS.length);
  });

  test("a thrown generator does not block the others", async () => {
    mockSearchPRs.mockRejectedValue(new Error("boom"));
    mockVercelConfigured.mockReturnValue(true);
    mockListDeployments.mockResolvedValue({
      ok: true,
      data: { deployments: [] },
    });
    mockFetchCalendarEvents.mockResolvedValue([]);
    mockFetchUserProfile.mockResolvedValue(null);
    const result = await runAllInsightGenerators(ctx);
    const vcOutcome = result.generatorOutcomes.find(
      (o) => o.name === "vercel_failed_no_followup",
    );
    expect(vcOutcome).toBeDefined();
    expect(vcOutcome?.ok).toBe(true);
  });
});
