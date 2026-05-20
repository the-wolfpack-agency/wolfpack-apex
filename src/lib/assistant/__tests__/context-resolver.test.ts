/**
 * context-resolver tests.
 *
 * Covers getRelevantContext: combines SharePoint + Project hits, respects
 * maxChars (drops longest first), emits the right analytics on truncation
 * and per-surface failure, returns empty bundle when token is missing,
 * 403 surfaces typed error on bundle.errors (never throws). Property test
 * asserts rendered_prompt_block.length <= maxChars.
 */
 

export {};

const mockTrack = jest.fn();
const mockGetValidToken = jest.fn();
const mockSearchSharePoint = jest.fn();
const mockSearchProjectTasks = jest.fn();
const mockTrackSpFail = jest.fn();
const mockTrackProjFail = jest.fn();
const mockSearchMeetingTranscripts = jest.fn();
const mockSearchCalendarEvents = jest.fn();
const mockSearchMessages = jest.fn();
const mockTrackCalFail = jest.fn();
const mockTrackEmailFail = jest.fn();
const mockSearchPorsche = jest.fn();
const mockTrackPorscheFail = jest.fn();

jest.mock("@/lib/analytics", () => ({
  trackEvent: (...args: any[]) => mockTrack(...args),
}));

const mockGetAppOnlyToken = jest.fn(() => Promise.resolve(null as string | null));
jest.mock("@/lib/microsoft-graph", () => ({
  getValidToken: (...args: any[]) => mockGetValidToken(...args),
  getAppOnlyToken: (...args: any[]) => mockGetAppOnlyToken(...args),
}));

jest.mock("@/lib/integrations/microsoft-sharepoint", () => ({
  searchSharePoint: (...args: any[]) => mockSearchSharePoint(...args),
  trackSharePointLookupFailure: (...args: any[]) => mockTrackSpFail(...args),
}));

jest.mock("@/lib/integrations/microsoft-project", () => ({
  searchProjectTasks: (...args: any[]) => mockSearchProjectTasks(...args),
  trackProjectLookupFailure: (...args: any[]) => mockTrackProjFail(...args),
}));

jest.mock("@/lib/integrations/microsoft-calendar", () => ({
  searchCalendarEvents: (...args: any[]) => mockSearchCalendarEvents(...args),
  trackCalendarLookupFailure: (...args: any[]) => mockTrackCalFail(...args),
}));

jest.mock("@/lib/integrations/microsoft-mail", () => ({
  searchMessages: (...args: any[]) => mockSearchMessages(...args),
  trackEmailLookupFailure: (...args: any[]) => mockTrackEmailFail(...args),
}));

jest.mock("@/lib/plaud", () => ({
  searchMeetingTranscripts: (...args: any[]) => mockSearchMeetingTranscripts(...args),
}));

jest.mock("@/lib/automations/porsche-classes/assistant-grounding", () => ({
  searchPorscheClassNotes: (...args: any[]) => mockSearchPorsche(...args),
  trackPorscheClassLookupFailure: (...args: any[]) => mockTrackPorscheFail(...args),
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockGetValidToken.mockResolvedValue({ accessToken: "tok-abc", userEmail: "u@example.com" });
  /* Default: meetings surface returns no hits unless a test overrides. */
  mockSearchMeetingTranscripts.mockResolvedValue([]);
  /* Default: calendar + email return empty success unless a test overrides.
     This keeps the existing 3-source tests honest about the "errors should
     be undefined when surfaces succeed-empty" contract. */
  mockSearchCalendarEvents.mockResolvedValue({
    ok: true,
    value: { hits: [], total: 0, took_ms: 1 },
  });
  mockSearchMessages.mockResolvedValue({
    ok: true,
    value: { hits: [], total: 0, took_ms: 1 },
  });
  /* Default: porsche grounding self-gates to empty on unrelated questions.
     Tests that exercise the porsche lane override this. */
  mockSearchPorsche.mockResolvedValue({ ok: true, hits: [], took_ms: 0 });
});

const baseHit = (i: number, snippetLen = 50) => ({
  title: `Doc ${i}`,
  url: `https://contoso.sharepoint.com/${i}`,
  snippet: "x".repeat(snippetLen),
  modifiedAt: "2026-04-01T00:00:00Z",
  source_kind: "sharepoint_doc" as const,
  driveItemId: `id${i}`,
  driveId: "d1",
});

const baseTask = (i: number) => ({
  id: `t${i}`,
  title: `Task ${i}`,
  plan_or_list_name: "Q2 Roadmap",
  status: "in_progress" as const,
  due_at: "2026-05-01T00:00:00Z",
  url: `https://tasks.office.com/task/${i}`,
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("getRelevantContext - happy path", () => {
  it("combines SharePoint hits + project tasks into a bundle and renders the prompt block", async () => {
    mockSearchSharePoint.mockResolvedValueOnce({
      ok: true,
      value: { hits: [baseHit(1), baseHit(2)], total: 2, took_ms: 12 },
    });
    mockSearchProjectTasks.mockResolvedValueOnce({
      ok: true,
      value: { tasks: [baseTask(1)], took_ms: 8 },
    });

    const { getRelevantContext } = await import("@/lib/assistant/context-resolver");
    const b = await getRelevantContext({
      question: "When does PTO accrual reset?",
      userId: "user-1",
      role: "cto",
      surface: "knowledge",
    });

    expect(b.sharepoint_hits).toHaveLength(2);
    expect(b.project_tasks).toHaveLength(1);
    expect(b.rendered_prompt_block).toContain("Internal context");
    expect(b.rendered_prompt_block).toContain("[SharePoint] Doc 1");
    expect(b.rendered_prompt_block).toContain("[Project task] Task 1");
    expect(b.total_chars).toBe(b.rendered_prompt_block.length);
    expect(b.errors).toBeUndefined();

    // Analytics: context_resolved fired with right counts.
    expect(mockTrack).toHaveBeenCalledWith(
      "assistant.context_resolved",
      "user-1",
      "cto",
      expect.objectContaining({
        surface: "knowledge",
        sharepoint_count: 2,
        project_count: 1,
      }),
    );
  });

  it("returns an empty bundle when getValidToken yields null", async () => {
    mockGetValidToken.mockResolvedValueOnce(null);
    const { getRelevantContext } = await import("@/lib/assistant/context-resolver");
    const b = await getRelevantContext({
      question: "anything",
      userId: "u",
      role: "user",
      surface: "knowledge",
    });
    expect(b.sharepoint_hits).toHaveLength(0);
    expect(b.project_tasks).toHaveLength(0);
    expect(b.rendered_prompt_block).toBe("");
    expect(mockSearchSharePoint).not.toHaveBeenCalled();
    expect(mockSearchProjectTasks).not.toHaveBeenCalled();
    // Still emits resolved (with zeros) so the learning loop sees the call.
    expect(mockTrack).toHaveBeenCalledWith(
      "assistant.context_resolved",
      "u",
      "user",
      expect.objectContaining({ sharepoint_count: 0, project_count: 0 }),
    );
  });

  it("returns empty bundle on empty question without calling Graph", async () => {
    const { getRelevantContext } = await import("@/lib/assistant/context-resolver");
    const b = await getRelevantContext({
      question: "   ",
      userId: "u",
      role: "user",
      surface: "knowledge",
    });
    expect(b.rendered_prompt_block).toBe("");
    expect(mockGetValidToken).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Truncation
// ---------------------------------------------------------------------------

describe("getRelevantContext - truncation", () => {
  it("respects maxChars and emits assistant.context_truncated when entries are dropped", async () => {
    // Build hits that together vastly exceed the cap.
    const fatHits = Array.from({ length: 6 }, (_, i) => baseHit(i + 1, 1000));
    mockSearchSharePoint.mockResolvedValueOnce({
      ok: true,
      value: { hits: fatHits, total: 6, took_ms: 1 },
    });
    mockSearchProjectTasks.mockResolvedValueOnce({
      ok: true,
      value: { tasks: [], took_ms: 1 },
    });

    const { getRelevantContext } = await import("@/lib/assistant/context-resolver");
    const b = await getRelevantContext({
      question: "anything",
      userId: "u",
      role: "user",
      surface: "knowledge",
      maxChars: 1500,
    });

    expect(b.rendered_prompt_block.length).toBeLessThanOrEqual(1500);
    // Some entries must have been dropped.
    expect(mockTrack).toHaveBeenCalledWith(
      "assistant.context_truncated",
      "u",
      "user",
      expect.objectContaining({
        surface: "knowledge",
        reason: "max_chars",
      }),
    );
  });

  it("property: rendered_prompt_block.length is always <= maxChars across many sizes", async () => {
    const { getRelevantContext } = await import("@/lib/assistant/context-resolver");

    const sizes = [600, 800, 1500, 3000, 6000, 12000];
    for (const cap of sizes) {
      mockSearchSharePoint.mockResolvedValueOnce({
        ok: true,
        value: {
          hits: Array.from({ length: 12 }, (_, i) => baseHit(i, 500)),
          total: 12, took_ms: 1,
        },
      });
      mockSearchProjectTasks.mockResolvedValueOnce({
        ok: true,
        value: {
          tasks: Array.from({ length: 8 }, (_, i) => baseTask(i)),
          took_ms: 1,
        },
      });
      const b = await getRelevantContext({
        question: `q${cap}`,
        userId: "u",
        role: "user",
        surface: "knowledge",
        maxChars: cap,
      });
      expect(b.rendered_prompt_block.length).toBeLessThanOrEqual(cap);
      // total_chars is a faithful mirror of rendered length.
      expect(b.total_chars).toBe(b.rendered_prompt_block.length);
    }
  });
});

// ---------------------------------------------------------------------------
// Per-surface failures
// ---------------------------------------------------------------------------

describe("getRelevantContext - per-surface failures", () => {
  it("returns project tasks when SharePoint 403s, with errors.sharepoint populated", async () => {
    mockSearchSharePoint.mockResolvedValueOnce({
      ok: false,
      code: "scope_missing",
      scope: "Sites.Read.All",
      status: 403,
      message: "forbidden",
    });
    mockSearchProjectTasks.mockResolvedValueOnce({
      ok: true,
      value: { tasks: [baseTask(1)], took_ms: 4 },
    });
    const { getRelevantContext } = await import("@/lib/assistant/context-resolver");
    const b = await getRelevantContext({
      question: "x",
      userId: "u",
      role: "user",
      surface: "knowledge",
    });
    expect(b.sharepoint_hits).toHaveLength(0);
    expect(b.project_tasks).toHaveLength(1);
    expect(b.errors?.sharepoint?.code).toBe("scope_missing");
    // SharePoint failure analytics fired.
    expect(mockTrackSpFail).toHaveBeenCalled();
    expect(mockTrackProjFail).not.toHaveBeenCalled();
  });

  it("returns SharePoint hits when project 403s, with errors.project populated", async () => {
    mockSearchSharePoint.mockResolvedValueOnce({
      ok: true,
      value: { hits: [baseHit(1)], total: 1, took_ms: 4 },
    });
    mockSearchProjectTasks.mockResolvedValueOnce({
      ok: false,
      code: "scope_missing",
      scope: "Tasks.ReadWrite.Shared",
      status: 403,
    });
    const { getRelevantContext } = await import("@/lib/assistant/context-resolver");
    const b = await getRelevantContext({
      question: "x",
      userId: "u",
      role: "user",
      surface: "assistant_support",
    });
    expect(b.sharepoint_hits).toHaveLength(1);
    expect(b.project_tasks).toHaveLength(0);
    expect(b.errors?.project?.code).toBe("scope_missing");
    expect(mockTrackProjFail).toHaveBeenCalled();
  });

  it("never throws when both surfaces fail - returns empty bundle with both errors", async () => {
    mockSearchSharePoint.mockResolvedValueOnce({
      ok: false, code: "scope_missing", scope: "Sites.Read.All", status: 403,
    });
    mockSearchProjectTasks.mockResolvedValueOnce({
      ok: false, code: "rate_limited", retryAfter: 5, status: 429,
    });
    const { getRelevantContext } = await import("@/lib/assistant/context-resolver");
    await expect(
      getRelevantContext({
        question: "x",
        userId: "u",
        role: "user",
        surface: "knowledge",
      }),
    ).resolves.toMatchObject({
      sharepoint_hits: [],
      project_tasks: [],
      errors: expect.objectContaining({
        sharepoint: expect.objectContaining({ code: "scope_missing" }),
        project: expect.objectContaining({ code: "rate_limited" }),
      }),
    });
  });
});

// ---------------------------------------------------------------------------
// Prompt block rendering details
// ---------------------------------------------------------------------------

describe("renderPromptBlock", () => {
  it("renders SharePoint and Project entries in the documented format", async () => {
    const { __internal } = await import("@/lib/assistant/context-resolver");
    const { rendered, dropped } = __internal.renderPromptBlock(
      [baseHit(1, 30)],
      [baseTask(1)],
      6000,
    );
    expect(rendered.startsWith("Internal context")).toBe(true);
    expect(rendered).toMatch(/\[SharePoint\] Doc 1 - https/);
    expect(rendered).toMatch(/\[Project task\] Task 1 \(Q2 Roadmap, status: in_progress, due:/);
    expect(dropped.total).toBe(0);
  });

  it("drops entries until the budget is honored", async () => {
    const { __internal } = await import("@/lib/assistant/context-resolver");
    const hits = [
      { ...baseHit(1, 100), snippet: "small" },
      { ...baseHit(2, 4000) }, // huge — likely dropped first
      { ...baseHit(3, 100), snippet: "small" },
    ];
    const { rendered, dropped } = __internal.renderPromptBlock(hits, [], 1000);
    expect(rendered.length).toBeLessThanOrEqual(1000);
    expect(dropped.total).toBeGreaterThan(0);
  });

  it("renders [Calendar] and [Email] entries via the new inputs object", async () => {
    const { __internal } = await import("@/lib/assistant/context-resolver");
    const cal = {
      id: "ev-1",
      subject: "Porsche dealer sync",
      start: "2026-03-12T15:00:00Z",
      end: "2026-03-12T16:00:00Z",
      attendees: ["Aidan", "Hoxsie"],
      snippet: "Walked through dealer pipeline",
      url: "https://outlook/ev-1",
      source_kind: "calendar" as const,
    };
    const email = {
      id: "m-1",
      subject: "Porsche pipeline",
      from: "Aidan",
      received_at: "2026-03-15T09:00:00Z",
      snippet: "Update on dealer pipeline",
      url: "https://outlook/m-1",
      source_kind: "email" as const,
    };
    const { rendered, dropped } = __internal.renderPromptBlock({
      hits: [],
      tasks: [],
      meetings: [],
      calendar: [cal],
      emails: [email],
      maxChars: 6000,
    });
    expect(rendered).toMatch(/\[Calendar\] Porsche dealer sync — 2026-03-12T15:00:00Z — with Aidan, Hoxsie/);
    expect(rendered).toContain("[Email] Porsche pipeline — from Aidan — 2026-03-15T09:00:00Z");
    expect(rendered).toContain("https://outlook/ev-1");
    expect(rendered).toContain("https://outlook/m-1");
    expect(dropped.calendar).toBe(0);
    expect(dropped.email).toBe(0);
    expect(dropped.total).toBe(0);
  });

  it("renders [Meeting] entries when meeting hits are passed", async () => {
    const { __internal } = await import("@/lib/assistant/context-resolver");
    const meetingHit = {
      id: "m-1",
      title: "Wolfpack standup",
      occurred_at: "2026-04-20T15:00:00Z",
      snippet: "Discussed Q2 OKRs and the dashboard rebuild.",
      source_kind: "plaud" as const,
      url: "/meetings/m-1",
    };
    const { rendered, dropped } = __internal.renderPromptBlock(
      [],
      [],
      [meetingHit],
      6000,
    );
    expect(rendered).toMatch(/\[Meeting\] Wolfpack standup — 2026-04-20T15:00:00Z/);
    expect(rendered).toContain("Discussed Q2 OKRs");
    expect(rendered).toContain("/meetings/m-1");
    expect(dropped.total).toBe(0);
    expect(dropped.meeting).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// extractDateRange
// ---------------------------------------------------------------------------

describe("extractDateRange", () => {
  const NOW = new Date(Date.UTC(2026, 3, 29, 12, 0, 0));

  it("parses 'April 20, 2026' to a single-day UTC range", async () => {
    const { __internal } = await import("@/lib/assistant/context-resolver");
    const r = __internal.extractDateRange("which meetings on April 20, 2026", NOW);
    expect(r).not.toBeNull();
    expect(r!.kind).toBe("day");
    expect(r!.startISO).toBe("2026-04-20T00:00:00.000Z");
    expect(r!.endISO).toBe("2026-04-20T23:59:59.999Z");
  });

  it("parses bare 'April 20' using current year", async () => {
    const { __internal } = await import("@/lib/assistant/context-resolver");
    const r = __internal.extractDateRange("what was discussed on April 20", NOW);
    expect(r).not.toBeNull();
    expect(r!.kind).toBe("day");
    expect(r!.startISO.startsWith("2026-04-20")).toBe(true);
  });

  it("parses 'March 2026' as a whole-month range", async () => {
    const { __internal } = await import("@/lib/assistant/context-resolver");
    const r = __internal.extractDateRange("what happened in March 2026", NOW);
    expect(r).not.toBeNull();
    expect(r!.kind).toBe("month");
    expect(r!.startISO).toBe("2026-03-01T00:00:00.000Z");
    expect(r!.endISO).toBe("2026-03-31T23:59:59.999Z");
  });

  it("parses ISO date 2026-04-20", async () => {
    const { __internal } = await import("@/lib/assistant/context-resolver");
    const r = __internal.extractDateRange("notes from 2026-04-20", NOW);
    expect(r).not.toBeNull();
    expect(r!.kind).toBe("day");
    expect(r!.startISO.startsWith("2026-04-20")).toBe(true);
  });

  it("parses US-style 4/20/2026", async () => {
    const { __internal } = await import("@/lib/assistant/context-resolver");
    const r = __internal.extractDateRange("anything from 4/20/2026?", NOW);
    expect(r).not.toBeNull();
    expect(r!.kind).toBe("day");
    expect(r!.startISO.startsWith("2026-04-20")).toBe(true);
  });

  it("returns null when no date is present", async () => {
    const { __internal } = await import("@/lib/assistant/context-resolver");
    expect(__internal.extractDateRange("how does auth work", NOW)).toBeNull();
    expect(__internal.extractDateRange("", NOW)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// searchMeetingNotes
// ---------------------------------------------------------------------------

describe("searchMeetingNotes", () => {
  const baseTranscript = (over: Record<string, unknown> = {}) => ({
    id: "m-1",
    fileId: "plaud-1",
    ownerUserId: "u-1",
    ownerName: "Nick",
    title: "Wolfpack sync",
    summary: "Q2 plans",
    transcriptText: "we discussed the dashboard rebuild and the demo on April 20",
    recordedAt: "2026-04-20T15:00:00Z",
    durationSeconds: 1800,
    qualityStatus: "pass" as const,
    ingestedAt: "2026-04-20T16:00:00Z",
    snippet: "discussed the dashboard rebuild and the demo on April 20",
    score: 5,
    ...over,
  });

  it("returns hits with clamped 300-char snippets", async () => {
    mockSearchMeetingTranscripts.mockResolvedValueOnce([
      baseTranscript({
        snippet: "x".repeat(800),
        summary: null,
      }),
    ]);
    const { searchMeetingNotes } = await import("@/lib/assistant/context-resolver");
    const r = await searchMeetingNotes({
      question: "what did we discuss",
      userId: "u-1",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.hits).toHaveLength(1);
    expect(r.hits[0].snippet.length).toBeLessThanOrEqual(300);
    expect(r.hits[0].source_kind).toBe("plaud");
    expect(r.hits[0].occurred_at).toBe("2026-04-20T15:00:00Z");
  });

  it("filters out hits outside the extracted date range", async () => {
    mockSearchMeetingTranscripts.mockResolvedValueOnce([
      baseTranscript({ id: "m-on", recordedAt: "2026-04-20T15:00:00Z" }),
      baseTranscript({ id: "m-off", recordedAt: "2026-03-15T10:00:00Z" }),
    ]);
    const { searchMeetingNotes } = await import("@/lib/assistant/context-resolver");
    const r = await searchMeetingNotes({
      question: "meetings on April 20, 2026",
      userId: "u-1",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.hits).toHaveLength(1);
    expect(r.hits[0].id).toBe("m-on");
  });

  it("filters by month when only month+year is in the question", async () => {
    mockSearchMeetingTranscripts.mockResolvedValueOnce([
      baseTranscript({ id: "in", recordedAt: "2026-03-12T15:00:00Z" }),
      baseTranscript({ id: "out", recordedAt: "2026-04-12T15:00:00Z" }),
    ]);
    const { searchMeetingNotes } = await import("@/lib/assistant/context-resolver");
    const r = await searchMeetingNotes({
      question: "what happened in March 2026",
      userId: "u-1",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.hits.map((h) => h.id)).toEqual(["in"]);
  });

  it("returns typed error result when the lookup throws", async () => {
    mockSearchMeetingTranscripts.mockRejectedValueOnce(new Error("DB exploded"));
    const { searchMeetingNotes } = await import("@/lib/assistant/context-resolver");
    const r = await searchMeetingNotes({
      question: "anything",
      userId: "u-1",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("internal");
    expect(r.status).toBe(500);
  });

  it("returns no_query error for an empty question", async () => {
    const { searchMeetingNotes } = await import("@/lib/assistant/context-resolver");
    const r = await searchMeetingNotes({ question: "  ", userId: "u-1" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("no_query");
    expect(mockSearchMeetingTranscripts).not.toHaveBeenCalled();
  });

  it("respects custom topN parameter", async () => {
    const transcripts = Array.from({ length: 8 }, (_, i) =>
      baseTranscript({ id: `m-${i}`, recordedAt: "2026-04-20T15:00:00Z" }),
    );
    mockSearchMeetingTranscripts.mockResolvedValueOnce(transcripts);
    const { searchMeetingNotes } = await import("@/lib/assistant/context-resolver");
    const r = await searchMeetingNotes({
      question: "meetings on April 20, 2026",
      userId: "u-1",
      topN: 3,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.hits).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// getRelevantContext meeting integration
// ---------------------------------------------------------------------------

describe("getRelevantContext - meeting integration", () => {
  const meetingTranscript = {
    id: "m-1",
    fileId: "plaud-1",
    ownerUserId: "u-1",
    ownerName: "Nick",
    title: "Wolfpack sync 4/20",
    summary: "Q2 OKRs and demo timing",
    transcriptText: "we walked through Q2 OKRs and the demo schedule",
    recordedAt: "2026-04-20T15:00:00Z",
    durationSeconds: 1800,
    qualityStatus: "pass" as const,
    ingestedAt: "2026-04-20T16:00:00Z",
    snippet: "we walked through Q2 OKRs and the demo schedule",
    score: 5,
  };

  it("includes meetings as a 3rd source and emits meeting_count in analytics", async () => {
    mockSearchSharePoint.mockResolvedValueOnce({
      ok: true, value: { hits: [baseHit(1)], total: 1, took_ms: 4 },
    });
    mockSearchProjectTasks.mockResolvedValueOnce({
      ok: true, value: { tasks: [baseTask(1)], took_ms: 4 },
    });
    mockSearchMeetingTranscripts.mockResolvedValueOnce([meetingTranscript]);

    const { getRelevantContext } = await import("@/lib/assistant/context-resolver");
    const b = await getRelevantContext({
      question: "what was discussed in meetings on April 20, 2026",
      userId: "u-1",
      role: "cto",
      surface: "assistant_support",
    });
    expect(b.meeting_notes).toHaveLength(1);
    expect(b.meeting_notes[0].id).toBe("m-1");
    expect(b.rendered_prompt_block).toContain("[Meeting]");
    expect(b.rendered_prompt_block).toContain("Wolfpack sync 4/20");
    expect(b.rendered_prompt_block).toContain("[SharePoint]");
    expect(b.rendered_prompt_block).toContain("[Project task]");
    expect(mockTrack).toHaveBeenCalledWith(
      "assistant.context_resolved",
      "u-1",
      "cto",
      expect.objectContaining({
        meeting_count: 1,
        sharepoint_count: 1,
        project_count: 1,
      }),
    );
  });

  it("still pulls meetings when the Graph token is missing", async () => {
    mockGetValidToken.mockResolvedValueOnce(null);
    mockSearchMeetingTranscripts.mockResolvedValueOnce([meetingTranscript]);
    const { getRelevantContext } = await import("@/lib/assistant/context-resolver");
    const b = await getRelevantContext({
      question: "what did we discuss on April 20, 2026",
      userId: "u-1",
      role: "cto",
      surface: "assistant_support",
    });
    /* SharePoint + Project skipped because no token, but meetings still flow. */
    expect(b.sharepoint_hits).toHaveLength(0);
    expect(b.project_tasks).toHaveLength(0);
    expect(b.meeting_notes).toHaveLength(1);
    expect(b.rendered_prompt_block).toContain("[Meeting]");
    expect(mockSearchSharePoint).not.toHaveBeenCalled();
  });

  it("emits assistant.meeting_lookup_failed and returns empty meetings when the lookup throws", async () => {
    mockSearchSharePoint.mockResolvedValueOnce({
      ok: true, value: { hits: [], total: 0, took_ms: 1 },
    });
    mockSearchProjectTasks.mockResolvedValueOnce({
      ok: true, value: { tasks: [], took_ms: 1 },
    });
    mockSearchMeetingTranscripts.mockRejectedValueOnce(new Error("PG down"));
    const { getRelevantContext } = await import("@/lib/assistant/context-resolver");
    const b = await getRelevantContext({
      question: "meetings on April 20, 2026",
      userId: "u-1",
      role: "cto",
      surface: "assistant_support",
    });
    expect(b.meeting_notes).toHaveLength(0);
    expect(b.errors?.meeting?.code).toBe("internal");
    expect(mockTrack).toHaveBeenCalledWith(
      "assistant.meeting_lookup_failed",
      "u-1",
      "cto",
      expect.objectContaining({ status: 500 }),
    );
  });

  it("respects per-source budget — long meeting hits get truncated", async () => {
    const fatMeeting = {
      ...meetingTranscript,
      summary: "x".repeat(2000),
      snippet: "y".repeat(2000),
    };
    mockSearchSharePoint.mockResolvedValueOnce({
      ok: true, value: { hits: [], total: 0, took_ms: 1 },
    });
    mockSearchProjectTasks.mockResolvedValueOnce({
      ok: true, value: { tasks: [], took_ms: 1 },
    });
    mockSearchMeetingTranscripts.mockResolvedValueOnce([
      fatMeeting,
      { ...fatMeeting, id: "m-2", recordedAt: "2026-04-20T16:00:00Z" },
      { ...fatMeeting, id: "m-3", recordedAt: "2026-04-20T17:00:00Z" },
    ]);
    const { getRelevantContext } = await import("@/lib/assistant/context-resolver");
    const b = await getRelevantContext({
      question: "April 20, 2026 meetings",
      userId: "u-1",
      role: "cto",
      surface: "assistant_support",
      maxChars: 800,
    });
    expect(b.rendered_prompt_block.length).toBeLessThanOrEqual(800);
    /* Per-hit snippet capped at 300 even before global truncation. */
    for (const hit of b.meeting_notes) {
      expect(hit.snippet.length).toBeLessThanOrEqual(300);
    }
  });
});

// ---------------------------------------------------------------------------
// getRelevantContext - calendar + email integration (Outlook surfaces)
// ---------------------------------------------------------------------------

describe("getRelevantContext - calendar + email integration", () => {
  const calendarHit = {
    id: "ev-1",
    subject: "Porsche dealer sync",
    start: "2026-03-12T15:00:00Z",
    end: "2026-03-12T16:00:00Z",
    organizer: "Nick",
    attendees: ["Aidan", "Hoxsie"],
    snippet: "Walked through dealer pipeline and Q2 incentives",
    url: "https://outlook.office.com/calendar/item/ev-1",
    source_kind: "calendar" as const,
  };

  const emailHit = {
    id: "msg-1",
    subject: "Porsche pipeline",
    from: "Aidan",
    received_at: "2026-03-15T09:00:00Z",
    snippet: "Update on the Porsche dealer pipeline status",
    url: "https://outlook.office.com/mail/msg-1",
    source_kind: "email" as const,
  };

  it("includes calendar + email as the 4th and 5th sources and renders both blocks", async () => {
    mockSearchSharePoint.mockResolvedValueOnce({
      ok: true, value: { hits: [baseHit(1)], total: 1, took_ms: 1 },
    });
    mockSearchProjectTasks.mockResolvedValueOnce({
      ok: true, value: { tasks: [baseTask(1)], took_ms: 1 },
    });
    mockSearchCalendarEvents.mockResolvedValueOnce({
      ok: true, value: { hits: [calendarHit], total: 1, took_ms: 1 },
    });
    mockSearchMessages.mockResolvedValueOnce({
      ok: true, value: { hits: [emailHit], total: 1, took_ms: 1 },
    });

    const { getRelevantContext } = await import("@/lib/assistant/context-resolver");
    const b = await getRelevantContext({
      question: "what did we discuss in the porsche meetings this month",
      userId: "u-1",
      role: "cto",
      surface: "assistant_support",
    });

    expect(b.calendar_events).toHaveLength(1);
    expect(b.email_threads).toHaveLength(1);
    expect(b.rendered_prompt_block).toContain("[Calendar] Porsche dealer sync");
    expect(b.rendered_prompt_block).toContain("[Email] Porsche pipeline");
    expect(b.rendered_prompt_block).toContain("with Aidan, Hoxsie");
    expect(b.rendered_prompt_block).toContain("from Aidan");
    /* The other 3 surfaces still render unchanged. */
    expect(b.rendered_prompt_block).toContain("[SharePoint]");
    expect(b.rendered_prompt_block).toContain("[Project task]");

    /* Analytics fired with calendar_count + email_count. */
    expect(mockTrack).toHaveBeenCalledWith(
      "assistant.context_resolved",
      "u-1",
      "cto",
      expect.objectContaining({
        calendar_count: 1,
        email_count: 1,
        sharepoint_count: 1,
        project_count: 1,
      }),
    );
  });

  it("returns the other 4 surfaces when calendar 403s; emits assistant.calendar_lookup_failed", async () => {
    mockSearchSharePoint.mockResolvedValueOnce({
      ok: true, value: { hits: [baseHit(1)], total: 1, took_ms: 1 },
    });
    mockSearchProjectTasks.mockResolvedValueOnce({
      ok: true, value: { tasks: [baseTask(1)], took_ms: 1 },
    });
    mockSearchCalendarEvents.mockResolvedValueOnce({
      ok: false, code: "scope_missing", scope: "Calendars.Read", status: 403,
    });
    mockSearchMessages.mockResolvedValueOnce({
      ok: true, value: { hits: [emailHit], total: 1, took_ms: 1 },
    });

    const { getRelevantContext } = await import("@/lib/assistant/context-resolver");
    const b = await getRelevantContext({
      question: "porsche review",
      userId: "u-1",
      role: "cto",
      surface: "knowledge",
    });
    expect(b.calendar_events).toHaveLength(0);
    expect(b.email_threads).toHaveLength(1);
    expect(b.sharepoint_hits).toHaveLength(1);
    expect(b.project_tasks).toHaveLength(1);
    expect(b.errors?.calendar?.code).toBe("scope_missing");
    expect(mockTrackCalFail).toHaveBeenCalled();
    expect(mockTrackEmailFail).not.toHaveBeenCalled();
  });

  it("returns the other 4 surfaces when email 403s; emits assistant.email_lookup_failed", async () => {
    mockSearchSharePoint.mockResolvedValueOnce({
      ok: true, value: { hits: [baseHit(1)], total: 1, took_ms: 1 },
    });
    mockSearchProjectTasks.mockResolvedValueOnce({
      ok: true, value: { tasks: [baseTask(1)], took_ms: 1 },
    });
    mockSearchCalendarEvents.mockResolvedValueOnce({
      ok: true, value: { hits: [calendarHit], total: 1, took_ms: 1 },
    });
    mockSearchMessages.mockResolvedValueOnce({
      ok: false, code: "scope_missing", scope: "Mail.Read", status: 403,
    });

    const { getRelevantContext } = await import("@/lib/assistant/context-resolver");
    const b = await getRelevantContext({
      question: "porsche pipeline",
      userId: "u-1",
      role: "cto",
      surface: "knowledge",
    });
    expect(b.email_threads).toHaveLength(0);
    expect(b.calendar_events).toHaveLength(1);
    expect(b.errors?.email?.code).toBe("scope_missing");
    expect(mockTrackEmailFail).toHaveBeenCalled();
  });

  it("never throws when all 4 Graph surfaces fail — returns bundle with errors only", async () => {
    mockSearchSharePoint.mockResolvedValueOnce({
      ok: false, code: "scope_missing", scope: "Sites.Read.All", status: 403,
    });
    mockSearchProjectTasks.mockResolvedValueOnce({
      ok: false, code: "rate_limited", retryAfter: 5, status: 429,
    });
    mockSearchCalendarEvents.mockResolvedValueOnce({
      ok: false, code: "scope_missing", scope: "Calendars.Read", status: 403,
    });
    mockSearchMessages.mockResolvedValueOnce({
      ok: false, code: "scope_missing", scope: "Mail.Read", status: 403,
    });

    const { getRelevantContext } = await import("@/lib/assistant/context-resolver");
    await expect(
      getRelevantContext({
        question: "anything",
        userId: "u-1",
        role: "cto",
        surface: "knowledge",
      }),
    ).resolves.toMatchObject({
      sharepoint_hits: [],
      project_tasks: [],
      calendar_events: [],
      email_threads: [],
      errors: expect.objectContaining({
        sharepoint: expect.objectContaining({ code: "scope_missing" }),
        project: expect.objectContaining({ code: "rate_limited" }),
        calendar: expect.objectContaining({ code: "scope_missing" }),
        email: expect.objectContaining({ code: "scope_missing" }),
      }),
    });
  });

  it("truncates longest entries first when 5 surfaces overflow maxChars", async () => {
    mockSearchSharePoint.mockResolvedValueOnce({
      ok: true,
      value: {
        hits: Array.from({ length: 4 }, (_, i) => baseHit(i, 600)),
        total: 4, took_ms: 1,
      },
    });
    mockSearchProjectTasks.mockResolvedValueOnce({
      ok: true, value: { tasks: [], took_ms: 1 },
    });
    mockSearchCalendarEvents.mockResolvedValueOnce({
      ok: true,
      value: {
        hits: Array.from({ length: 3 }, (_, i) => ({
          ...calendarHit,
          id: `ev-${i}`,
          snippet: "z".repeat(300),
        })),
        total: 3, took_ms: 1,
      },
    });
    mockSearchMessages.mockResolvedValueOnce({
      ok: true,
      value: {
        hits: Array.from({ length: 3 }, (_, i) => ({
          ...emailHit,
          id: `msg-${i}`,
          snippet: "y".repeat(300),
        })),
        total: 3, took_ms: 1,
      },
    });

    const { getRelevantContext } = await import("@/lib/assistant/context-resolver");
    const b = await getRelevantContext({
      question: "porsche review march",
      userId: "u-1",
      role: "cto",
      surface: "knowledge",
      maxChars: 1500,
    });
    expect(b.rendered_prompt_block.length).toBeLessThanOrEqual(1500);
    /* Truncation event must be tagged with the new dropped_calendar +
       dropped_email surfaces so the dashboard can attribute drops. */
    expect(mockTrack).toHaveBeenCalledWith(
      "assistant.context_truncated",
      "u-1",
      "cto",
      expect.objectContaining({
        reason: "max_chars",
        dropped_calendar: expect.any(Number),
        dropped_email: expect.any(Number),
      }),
    );
  });

  it("skips Graph surfaces (calendar + email) when token is missing but still returns bundle", async () => {
    mockGetValidToken.mockResolvedValueOnce(null);
    const { getRelevantContext } = await import("@/lib/assistant/context-resolver");
    const b = await getRelevantContext({
      question: "porsche meetings march",
      userId: "u-1",
      role: "cto",
      surface: "assistant_support",
    });
    expect(b.calendar_events).toHaveLength(0);
    expect(b.email_threads).toHaveLength(0);
    expect(mockSearchCalendarEvents).not.toHaveBeenCalled();
    expect(mockSearchMessages).not.toHaveBeenCalled();
    /* Analytics still emitted with zeros so the learning loop sees the call. */
    expect(mockTrack).toHaveBeenCalledWith(
      "assistant.context_resolved",
      "u-1",
      "cto",
      expect.objectContaining({ calendar_count: 0, email_count: 0 }),
    );
  });

  it("forwards extracted date range to calendar search", async () => {
    mockSearchSharePoint.mockResolvedValueOnce({
      ok: true, value: { hits: [], total: 0, took_ms: 1 },
    });
    mockSearchProjectTasks.mockResolvedValueOnce({
      ok: true, value: { tasks: [], took_ms: 1 },
    });
    mockSearchCalendarEvents.mockResolvedValueOnce({
      ok: true, value: { hits: [], total: 0, took_ms: 1 },
    });
    mockSearchMessages.mockResolvedValueOnce({
      ok: true, value: { hits: [], total: 0, took_ms: 1 },
    });
    const { getRelevantContext } = await import("@/lib/assistant/context-resolver");
    await getRelevantContext({
      question: "what did we discuss in March 2026 porsche meetings",
      userId: "u-1",
      role: "cto",
      surface: "knowledge",
    });
    expect(mockSearchCalendarEvents).toHaveBeenCalledWith(
      "tok-abc",
      expect.objectContaining({
        startDateTime: "2026-03-01T00:00:00.000Z",
        endDateTime: "2026-03-31T23:59:59.999Z",
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Porsche-class grounding lane
// ---------------------------------------------------------------------------

describe("getRelevantContext - porsche-class grounding", () => {
  it("merges porsche-class hits into meeting_notes alongside plaud", async () => {
    /* Plaud returns one hit. */
    mockSearchMeetingTranscripts.mockResolvedValueOnce([
      {
        id: "plaud-1",
        title: "Sales sync",
        summary: "",
        snippet: "Discussed Q2 pipeline",
        score: 0.8,
        recordedAt: "2026-04-20T15:00:00Z",
        ingestedAt: "2026-04-20T15:30:00Z",
      },
    ]);
    /* Porsche returns one snapshot. */
    mockSearchPorsche.mockResolvedValueOnce({
      ok: true,
      hits: [
        {
          id: "snap-1",
          title: "BA101 2026-04-20 Atlanta",
          occurred_at: "2026-04-20T15:00:00Z",
          snippet: "12 participants · +2 added (Smith, Jones)",
          source_kind: "porsche_class",
          url: "/automations/porsche-classes",
        },
      ],
      took_ms: 2,
    });
    mockSearchSharePoint.mockResolvedValueOnce({
      ok: true,
      value: { hits: [], total: 0, took_ms: 1 },
    });
    mockSearchProjectTasks.mockResolvedValueOnce({
      ok: true,
      value: { tasks: [], took_ms: 1 },
    });
    mockSearchCalendarEvents.mockResolvedValueOnce({
      ok: true,
      value: { hits: [], total: 0, took_ms: 1 },
    });
    mockSearchMessages.mockResolvedValueOnce({
      ok: true,
      value: { hits: [], total: 0, took_ms: 1 },
    });

    const { getRelevantContext } = await import("@/lib/assistant/context-resolver");
    const bundle = await getRelevantContext({
      question: "what changed in BA101 on April 20",
      userId: "u-1",
      role: "cto",
      surface: "assistant_support",
    });

    /* Both grounding lanes are present. */
    expect(bundle.meeting_notes).toHaveLength(2);
    const porscheHit = bundle.meeting_notes.find((h) => h.source_kind === "porsche_class");
    expect(porscheHit).toBeDefined();
    expect(porscheHit?.title).toBe("BA101 2026-04-20 Atlanta");
    expect(porscheHit?.url).toBe("/automations/porsche-classes");
    /* The rendered prompt block carries the porsche snippet so the LLM
       can cite it inline. */
    expect(bundle.rendered_prompt_block).toContain("BA101 2026-04-20 Atlanta");
    expect(bundle.rendered_prompt_block).toContain("+2 added");
  });

  it("fires trackPorscheClassLookupFailure on grounding error and still returns the rest of the bundle", async () => {
    mockSearchPorsche.mockResolvedValueOnce({
      ok: false,
      status: 500,
      code: "internal",
      message: "db down",
    });
    mockSearchSharePoint.mockResolvedValueOnce({
      ok: true,
      value: { hits: [baseHit(1)], total: 1, took_ms: 1 },
    });
    mockSearchProjectTasks.mockResolvedValueOnce({
      ok: true, value: { tasks: [], took_ms: 1 },
    });
    mockSearchCalendarEvents.mockResolvedValueOnce({
      ok: true, value: { hits: [], total: 0, took_ms: 1 },
    });
    mockSearchMessages.mockResolvedValueOnce({
      ok: true, value: { hits: [], total: 0, took_ms: 1 },
    });

    const { getRelevantContext } = await import("@/lib/assistant/context-resolver");
    const bundle = await getRelevantContext({
      question: "what classes ran last Friday",
      userId: "u-1",
      role: "cto",
      surface: "assistant_support",
    });

    expect(mockTrackPorscheFail).toHaveBeenCalledTimes(1);
    /* SharePoint hit still landed; the bundle isn't aborted. */
    expect(bundle.sharepoint_hits).toHaveLength(1);
  });
});
