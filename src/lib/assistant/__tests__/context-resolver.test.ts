/**
 * context-resolver tests.
 *
 * Covers getRelevantContext: combines SharePoint + Project hits, respects
 * maxChars (drops longest first), emits the right analytics on truncation
 * and per-surface failure, returns empty bundle when token is missing,
 * 403 surfaces typed error on bundle.errors (never throws). Property test
 * asserts rendered_prompt_block.length <= maxChars.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

export {};

const mockTrack = jest.fn();
const mockGetValidToken = jest.fn();
const mockSearchSharePoint = jest.fn();
const mockSearchProjectTasks = jest.fn();
const mockTrackSpFail = jest.fn();
const mockTrackProjFail = jest.fn();

jest.mock("@/lib/analytics", () => ({
  trackEvent: (...args: any[]) => mockTrack(...args),
}));

jest.mock("@/lib/microsoft-graph", () => ({
  getValidToken: (...args: any[]) => mockGetValidToken(...args),
}));

jest.mock("@/lib/integrations/microsoft-sharepoint", () => ({
  searchSharePoint: (...args: any[]) => mockSearchSharePoint(...args),
  trackSharePointLookupFailure: (...args: any[]) => mockTrackSpFail(...args),
}));

jest.mock("@/lib/integrations/microsoft-project", () => ({
  searchProjectTasks: (...args: any[]) => mockSearchProjectTasks(...args),
  trackProjectLookupFailure: (...args: any[]) => mockTrackProjFail(...args),
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockGetValidToken.mockResolvedValue({ accessToken: "tok-abc", userEmail: "u@example.com" });
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
});
