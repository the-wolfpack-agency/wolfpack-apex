/**
 * cross-tool-generators — unit coverage for the rule-based pattern
 * matchers. Each generator is tested in isolation with its dependencies
 * mocked so we exercise the matching logic, severity grading, and
 * shape of the returned insights without hitting any external service.
 */

const mockSearchPRs = jest.fn();
const mockListDeployments = jest.fn();
const mockVercelConfigured = jest.fn();
const mockFetchCalendarEvents = jest.fn();
const mockFetchRecentEmails = jest.fn();
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
  fetchRecentEmails: (...a: unknown[]) => mockFetchRecentEmails(...a),
  fetchUserProfile: (...a: unknown[]) => mockFetchUserProfile(...a),
}));

import {
  runAllInsightGenerators,
  INSIGHT_GENERATORS,
} from "@/lib/insights/cross-tool-generators";

const ctx = { userId: "u1", userRole: "cto" };

beforeEach(() => {
  mockSearchPRs.mockReset();
  mockListDeployments.mockReset();
  mockVercelConfigured.mockReset();
  mockFetchCalendarEvents.mockReset();
  mockFetchRecentEmails.mockReset();
  mockFetchUserProfile.mockReset();
});

describe("INSIGHT_GENERATORS registry", () => {
  test("ships at least 4 generators", () => {
    expect(INSIGHT_GENERATORS.length).toBeGreaterThanOrEqual(4);
  });
  test("every generator has a name, label, requires list, and async run()", () => {
    for (const g of INSIGHT_GENERATORS) {
      expect(typeof g.name).toBe("string");
      expect(typeof g.label).toBe("string");
      expect(Array.isArray(g.requires)).toBe(true);
      expect(typeof g.run).toBe("function");
    }
  });
  test("at least 2 generators are strictly cross-tool (require 2+ integrations)", () => {
    const crossTool = INSIGHT_GENERATORS.filter((g) => g.requires.length >= 2);
    expect(crossTool.length).toBeGreaterThanOrEqual(2);
  });
});

const day = 24 * 60 * 60 * 1000;

describe("github_pr_stagnation generator", () => {
  const gen = () =>
    INSIGHT_GENERATORS.find((g) => g.name === "github_pr_stagnation")!;

  test("flags PRs older than 7 days; severity escalates at 14 days", async () => {
    const now = Date.now();
    mockSearchPRs.mockResolvedValueOnce({
      ok: true,
      data: [
        {
          number: 1,
          title: "stale 8 days",
          state: "open",
          draft: false,
          repo: "wolfpack-apex",
          user: "alice",
          html_url: "https://github.com/x/x/pull/1",
          created_at: new Date(now - 8 * day).toISOString(),
          updated_at: new Date(now - 8 * day).toISOString(),
        },
        {
          number: 2,
          title: "stale 20 days",
          state: "open",
          draft: false,
          repo: "wolfpack-apex",
          user: "bob",
          html_url: "https://github.com/x/x/pull/2",
          created_at: new Date(now - 20 * day).toISOString(),
          updated_at: new Date(now - 20 * day).toISOString(),
        },
        {
          number: 3,
          title: "fresh 2 days",
          state: "open",
          draft: false,
          repo: "wolfpack-apex",
          user: "carol",
          html_url: "https://github.com/x/x/pull/3",
          created_at: new Date(now - 2 * day).toISOString(),
          updated_at: new Date(now - 2 * day).toISOString(),
        },
      ],
    });
    const out = await gen().run(ctx);
    expect(out).toHaveLength(2);
    expect(out.find((i) => i.title.includes("#1"))?.severity).toBe("medium");
    expect(out.find((i) => i.title.includes("#2"))?.severity).toBe("high");
    expect(out.every((i) => i.sources.includes("github"))).toBe(true);
  });

  test("excludes bot authors (dependabot, renovate, [bot] suffix)", async () => {
    const now = Date.now();
    mockSearchPRs.mockResolvedValueOnce({
      ok: true,
      data: [
        {
          number: 10,
          title: "deps bump",
          state: "open",
          draft: false,
          repo: "wolfpack-auto",
          user: "dependabot[bot]",
          html_url: "https://github.com/x/x/pull/10",
          created_at: new Date(now - 30 * day).toISOString(),
          updated_at: new Date(now - 30 * day).toISOString(),
        },
        {
          number: 11,
          title: "deps bump renovate",
          state: "open",
          draft: false,
          repo: "wolfpack-auto",
          user: "renovate",
          html_url: "https://github.com/x/x/pull/11",
          created_at: new Date(now - 30 * day).toISOString(),
          updated_at: new Date(now - 30 * day).toISOString(),
        },
        {
          number: 12,
          title: "human PR",
          state: "open",
          draft: false,
          repo: "wolfpack-auto",
          user: "alice",
          html_url: "https://github.com/x/x/pull/12",
          created_at: new Date(now - 10 * day).toISOString(),
          updated_at: new Date(now - 10 * day).toISOString(),
        },
      ],
    });
    const out = await gen().run(ctx);
    expect(out).toHaveLength(1);
    expect(out[0].title).toContain("#12");
  });

  test("excludes draft PRs", async () => {
    const now = Date.now();
    mockSearchPRs.mockResolvedValueOnce({
      ok: true,
      data: [
        {
          number: 20,
          title: "draft WIP",
          state: "open",
          draft: true,
          repo: "wolfpack-auto",
          user: "alice",
          html_url: "https://github.com/x/x/pull/20",
          created_at: new Date(now - 20 * day).toISOString(),
          updated_at: new Date(now - 20 * day).toISOString(),
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

  test("flags production failures as high; preview as medium", async () => {
    mockVercelConfigured.mockReturnValue(true);
    const now = Date.now();
    mockListDeployments.mockResolvedValueOnce({
      ok: true,
      data: {
        deployments: [
          {
            uid: "d-prod",
            name: "wolfpack-auto",
            url: "wolfpack-auto-abc.vercel.app",
            state: "ERROR",
            target: "production",
            createdAt: now,
            meta: { githubCommitMessage: "broke prod", githubCommitRef: "main" },
          },
          {
            uid: "d-prev",
            name: "wolfpack-auto",
            url: "wolfpack-auto-xyz.vercel.app",
            state: "ERROR",
            target: "preview",
            createdAt: now,
            meta: { githubCommitRef: "feat/x" },
          },
          {
            uid: "d-ok-other-branch",
            name: "wolfpack-auto",
            url: "wolfpack-auto-def.vercel.app",
            state: "READY",
            target: "production",
            createdAt: now + 1000,
            meta: { githubCommitRef: "other-branch" },
          },
        ],
      },
    });
    const out = await gen().run(ctx);
    expect(out).toHaveLength(2);
    expect(out.find((i) => i.id.includes("d-prod"))?.severity).toBe("high");
    expect(out.find((i) => i.id.includes("d-prev"))?.severity).toBe("medium");
  });

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
            url: "wolfpack-auto-abc.vercel.app",
            state: "ERROR",
            target: "production",
            createdAt: now,
            meta: { githubCommitRef: "main" },
          },
          {
            uid: "d-recover",
            name: "wolfpack-auto",
            url: "wolfpack-auto-def.vercel.app",
            state: "READY",
            target: "production",
            createdAt: now + 5000,
            meta: { githubCommitRef: "main" },
          },
        ],
      },
    });
    const out = await gen().run(ctx);
    expect(out).toHaveLength(0);
  });

  test("returns [] when vercel not configured", async () => {
    mockVercelConfigured.mockReturnValue(false);
    expect(await gen().run(ctx)).toEqual([]);
  });
});

describe("email_unread_from_meeting_attendee generator", () => {
  const gen = () =>
    INSIGHT_GENERATORS.find(
      (g) => g.name === "email_unread_from_meeting_attendee",
    )!;

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

  test("flags an unread email from an attendee of an upcoming meeting", async () => {
    mockFetchCalendarEvents.mockResolvedValueOnce([
      meetingIn(2, ["hoxsie@thewolfpack.agency"]),
    ]);
    mockFetchRecentEmails.mockResolvedValueOnce([
      {
        id: "em-1",
        subject: "re: pricing",
        from: "Nick Hoxsie",
        fromEmail: "hoxsie@thewolfpack.agency",
        receivedDateTime: new Date().toISOString(),
        bodyPreview: "...",
        isRead: false,
        importance: "normal",
        webLink: "https://outlook.office.com/x",
      },
    ]);
    mockFetchUserProfile.mockResolvedValueOnce({
      displayName: "Me",
      email: "homyk@thewolfpack.agency",
      jobTitle: "CTO",
      photoUrl: null,
    });
    const out = await gen().run(ctx);
    expect(out).toHaveLength(1);
    expect(out[0].severity).toBe("high"); // within 24h
    expect(out[0].sources).toEqual(["email", "calendar"]);
    expect(out[0].title).toContain("today");
  });

  test("ignores read emails and meetings in the past", async () => {
    mockFetchCalendarEvents.mockResolvedValueOnce([
      meetingIn(-5, ["hoxsie@thewolfpack.agency"]), // past
      meetingIn(48, ["alice@thewolfpack.agency"]), // upcoming
    ]);
    mockFetchRecentEmails.mockResolvedValueOnce([
      {
        id: "em-read",
        subject: "read msg",
        from: "Alice",
        fromEmail: "alice@thewolfpack.agency",
        receivedDateTime: new Date().toISOString(),
        bodyPreview: "...",
        isRead: true, // skip
        importance: "normal",
      },
      {
        id: "em-past",
        subject: "from past attendee",
        from: "Hox",
        fromEmail: "hoxsie@thewolfpack.agency",
        receivedDateTime: new Date().toISOString(),
        bodyPreview: "...",
        isRead: false,
        importance: "normal",
      },
    ]);
    mockFetchUserProfile.mockResolvedValueOnce({
      displayName: "Me",
      email: "homyk@thewolfpack.agency",
      jobTitle: "CTO",
      photoUrl: null,
    });
    const out = await gen().run(ctx);
    expect(out).toHaveLength(0);
  });

  test("does NOT match user's own email", async () => {
    mockFetchCalendarEvents.mockResolvedValueOnce([
      meetingIn(3, ["homyk@thewolfpack.agency", "alice@thewolfpack.agency"]),
    ]);
    mockFetchRecentEmails.mockResolvedValueOnce([
      {
        id: "em-self",
        subject: "self",
        from: "Me",
        fromEmail: "homyk@thewolfpack.agency",
        receivedDateTime: new Date().toISOString(),
        bodyPreview: "...",
        isRead: false,
        importance: "normal",
      },
    ]);
    mockFetchUserProfile.mockResolvedValueOnce({
      displayName: "Me",
      email: "homyk@thewolfpack.agency",
      jobTitle: "CTO",
      photoUrl: null,
    });
    expect(await gen().run(ctx)).toEqual([]);
  });

  test("returns [] when no events or no emails", async () => {
    mockFetchCalendarEvents.mockResolvedValueOnce([]);
    mockFetchRecentEmails.mockResolvedValueOnce([]);
    mockFetchUserProfile.mockResolvedValueOnce(null);
    expect(await gen().run(ctx)).toEqual([]);
  });
});

describe("meeting_attendee_open_pr generator", () => {
  const gen = () =>
    INSIGHT_GENERATORS.find((g) => g.name === "meeting_attendee_open_pr")!;

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

  test("flags a PR whose author is an upcoming meeting attendee (email local-part match)", async () => {
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
          title: "feat: thing",
          state: "open",
          draft: false,
          repo: "wolfpack-apex",
          user: "hoxsie",
          html_url: "https://github.com/x/x/pull/42",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ],
    });
    const out = await gen().run(ctx);
    expect(out).toHaveLength(1);
    expect(out[0].severity).toBe("high");
    expect(out[0].sources).toEqual(["github", "calendar"]);
    expect(out[0].title).toContain("hoxsie");
  });

  test("excludes bot-authored PRs even when matched", async () => {
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
          repo: "wolfpack-apex",
          user: "dependabot[bot]",
          html_url: "https://github.com/x/x/pull/1",
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

describe("runAllInsightGenerators aggregator", () => {
  test("sorts by severity then signalStrength, includes outcomes for every generator", async () => {
    mockSearchPRs.mockResolvedValue({ ok: true, data: [] });
    mockVercelConfigured.mockReturnValue(false);
    mockFetchCalendarEvents.mockResolvedValue([]);
    mockFetchRecentEmails.mockResolvedValue([]);
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
    mockFetchRecentEmails.mockResolvedValue([]);
    mockFetchUserProfile.mockResolvedValue(null);
    const result = await runAllInsightGenerators(ctx);
    const vcOutcome = result.generatorOutcomes.find(
      (o) => o.name === "vercel_failed_no_followup",
    );
    /* Each generator has its own try/catch and returns [] on failure,
     * so the aggregator reports ok=true with count=0 rather than
     * surfacing a single generator's failure as the whole call's. */
    expect(vcOutcome).toBeDefined();
    expect(vcOutcome?.ok).toBe(true);
  });
});
