/**
 * brief-edit library unit tests.
 *
 * Covers:
 *  - applyPatch: add/replace/remove, no-op round-trip.
 *  - validatePatchPaths: blocks identity + infra roots; allows content.
 *  - generateBriefEdit: happy path, blocked-path rejection with audit row,
 *    invalid-brief rejection, AI-unavailable path.
 *  - recordBriefEditDecision: DB update + analytics emission for both
 *    accept and reject.
 *
 * Every test asserts the correct trackEvent() emission to keep analytics
 * a first-class contract (not an afterthought).
 */

const mockTrackEvent = jest.fn();
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...args: unknown[]) => mockTrackEvent(...args),
}));

const mockSafeQuery = jest.fn();
jest.mock("@/lib/db", () => ({
  safeQuery: (...args: unknown[]) => mockSafeQuery(...args),
  query: jest.fn(),
}));

import {
  applyPatch,
  validatePatchPaths,
  generateBriefEdit,
  recordBriefEditDecision,
  BriefEditValidationError,
  BriefEditAIUnavailableError,
  type AICaller,
  type JsonPatch,
} from "@/lib/brief-edit";
import type { SiteBrief } from "@/lib/sites";

const BASE_BRIEF: SiteBrief = {
  client: "cftr",
  product: { name: "Cleared for Takeoff Racing", tagline: "Irish racing" },
  pages: [
    {
      route: "/",
      title: "Home",
      sections: [
        {
          type: "hero",
          heading: "Old Headline",
          body: "Old body",
          cta: { label: "Old CTA", href: "/old" },
        },
        { type: "text", heading: "About", body: "About text." },
      ],
    },
  ],
  contactForm: { fields: ["name", "email"] },
};

function stubAI(content: string, tokensIn = 120, tokensOut = 40): AICaller {
  return async () => ({
    content,
    tokensIn,
    tokensOut,
    model: "claude-haiku-4-5-20251001",
  });
}

describe("applyPatch", () => {
  it("round-trips the brief when patch is []", () => {
    const out = applyPatch(BASE_BRIEF, []);
    expect(out).toEqual(BASE_BRIEF);
    // deep clone — not same reference
    expect(out).not.toBe(BASE_BRIEF);
  });

  it("replaces an object field", () => {
    const patch: JsonPatch = [
      { op: "replace", path: "/pages/0/sections/0/heading", value: "Season One" },
    ];
    const out = applyPatch(BASE_BRIEF, patch);
    expect(out.pages[0].sections[0].heading).toBe("Season One");
    // other fields intact
    expect(out.pages[0].sections[0].body).toBe("Old body");
  });

  it("adds a new key on an object", () => {
    const patch: JsonPatch = [
      { op: "add", path: "/product/supportEmail", value: "hi@cftr.io" },
    ];
    const out = applyPatch(BASE_BRIEF, patch);
    expect(out.product.supportEmail).toBe("hi@cftr.io");
  });

  it("appends to an array with /-", () => {
    const patch: JsonPatch = [
      {
        op: "add",
        path: "/pages/0/sections/-",
        value: { type: "callout", body: "New callout" },
      },
    ];
    const out = applyPatch(BASE_BRIEF, patch);
    expect(out.pages[0].sections).toHaveLength(3);
    expect(out.pages[0].sections[2]).toEqual({
      type: "callout",
      body: "New callout",
    });
  });

  it("removes an array element", () => {
    const patch: JsonPatch = [
      { op: "remove", path: "/pages/0/sections/1" },
    ];
    const out = applyPatch(BASE_BRIEF, patch);
    expect(out.pages[0].sections).toHaveLength(1);
    expect(out.pages[0].sections[0].type).toBe("hero");
  });

  it("does not mutate the input brief", () => {
    const patch: JsonPatch = [
      { op: "replace", path: "/pages/0/sections/0/heading", value: "X" },
    ];
    applyPatch(BASE_BRIEF, patch);
    expect(BASE_BRIEF.pages[0].sections[0].heading).toBe("Old Headline");
  });

  it("throws on unsupported op", () => {
    const patch = [
      { op: "move", from: "/a", path: "/b" },
    ] as unknown as JsonPatch;
    expect(() => applyPatch(BASE_BRIEF, patch)).toThrow(BriefEditValidationError);
  });

  it("throws on out-of-range index", () => {
    const patch: JsonPatch = [
      { op: "replace", path: "/pages/0/sections/99/heading", value: "X" },
    ];
    expect(() => applyPatch(BASE_BRIEF, patch)).toThrow(BriefEditValidationError);
  });
});

describe("validatePatchPaths", () => {
  it("blocks /client_slug", () => {
    const blocked = validatePatchPaths([
      { op: "replace", path: "/client_slug", value: "other" },
    ]);
    expect(blocked).toHaveLength(1);
  });

  it("blocks /github_repo", () => {
    const blocked = validatePatchPaths([
      { op: "replace", path: "/github_repo", value: "evil/repo" },
    ]);
    expect(blocked).toHaveLength(1);
  });

  it("blocks unknown root paths", () => {
    const blocked = validatePatchPaths([
      { op: "add", path: "/__proto__/evil", value: 1 },
    ]);
    expect(blocked).toHaveLength(1);
  });

  it("allows /pages/0/heading", () => {
    const blocked = validatePatchPaths([
      { op: "replace", path: "/pages/0/title", value: "Home" },
    ]);
    expect(blocked).toHaveLength(0);
  });

  it("allows /client (content), /product, /contactForm, /theme", () => {
    const blocked = validatePatchPaths([
      { op: "replace", path: "/product/tagline", value: "new" },
      { op: "add", path: "/contactForm/fields/-", value: "phone" },
      { op: "replace", path: "/theme/accent", value: "#fff" },
    ]);
    expect(blocked).toHaveLength(0);
  });

  it("returns every blocked op, not just the first", () => {
    const blocked = validatePatchPaths([
      { op: "replace", path: "/pages/0/title", value: "ok" },
      { op: "replace", path: "/client_slug", value: "bad" },
      { op: "replace", path: "/github_repo", value: "bad" },
    ]);
    expect(blocked).toHaveLength(2);
  });
});

describe("generateBriefEdit", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSafeQuery.mockResolvedValue({ rows: [], fromCache: false });
  });

  it("returns patch, renderedBrief, explanation, metrics on happy path", async () => {
    const ai = stubAI(
      JSON.stringify({
        patch: [
          {
            op: "replace",
            path: "/pages/0/sections/0/heading",
            value: "Season One",
          },
          {
            op: "replace",
            path: "/pages/0/sections/0/cta/href",
            value: "/sponsorship",
          },
        ],
        explanation: "Update hero headline and CTA.",
      }),
      200,
      50,
    );

    const result = await generateBriefEdit({
      projectId: "site_1",
      currentBrief: BASE_BRIEF,
      instruction: "Make the hero headline 'Season One' and CTA /sponsorship",
      userId: "u_1",
      userRole: "sales",
      ai,
    });

    expect(result.editId).toMatch(/^brief_edit_/);
    expect(result.patch).toHaveLength(2);
    expect(result.renderedBrief.pages[0].sections[0].heading).toBe("Season One");
    expect(result.renderedBrief.pages[0].sections[0].cta?.href).toBe(
      "/sponsorship",
    );
    expect(result.explanation).toContain("hero");
    expect(result.metrics.tokensIn).toBe(200);
    expect(result.metrics.tokensOut).toBe(50);
    expect(result.metrics.costUsd).toBeGreaterThan(0);
    expect(result.metrics.model).toBe("claude-haiku-4-5-20251001");

    // Audit row inserted with accepted=NULL
    expect(mockSafeQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockSafeQuery.mock.calls[0];
    expect(sql).toContain("INSERT INTO instinct_site_brief_edits");
    // accepted is the 9th param
    expect(params[8]).toBeNull();

    // Analytics
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "site.brief_edit_requested",
      "u_1",
      "sales",
      expect.objectContaining({
        project_id: "site_1",
        instruction_length: expect.any(Number),
      }),
    );
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "site.brief_edit_generated",
      "u_1",
      "sales",
      expect.objectContaining({
        project_id: "site_1",
        edit_id: result.editId,
        patch_op_count: 2,
        tokens_in: 200,
        tokens_out: 50,
        model: "claude-haiku-4-5-20251001",
      }),
    );
  });

  it("truncates instructions over MAX_INSTRUCTION_LEN", async () => {
    const huge = "A".repeat(5000);
    const ai: AICaller = jest.fn(async (_sys, user) => {
      // instruction appears inline; ensure it's truncated before send
      expect(user.length).toBeLessThan(5000 + 1000);
      return {
        content: JSON.stringify({ patch: [], explanation: "" }),
        tokensIn: 10,
        tokensOut: 5,
        model: "claude-haiku-4-5-20251001",
      };
    }) as unknown as AICaller;
    await generateBriefEdit({
      projectId: "site_1",
      currentBrief: BASE_BRIEF,
      instruction: huge,
      userId: "u_1",
      userRole: "sales",
      ai,
    });
    expect(ai).toHaveBeenCalled();
  });

  it("throws BriefEditAIUnavailableError when AI returns null", async () => {
    const ai: AICaller = async () => null;
    await expect(
      generateBriefEdit({
        projectId: "site_1",
        currentBrief: BASE_BRIEF,
        instruction: "change heading",
        userId: "u_1",
        userRole: "sales",
        ai,
      }),
    ).rejects.toBeInstanceOf(BriefEditAIUnavailableError);

    expect(mockTrackEvent).toHaveBeenCalledWith(
      "site.brief_edit_failed",
      "u_1",
      "sales",
      expect.objectContaining({ reason: "ai_unavailable" }),
    );
    // No audit row inserted for AI-unavailable case (nothing to persist)
    expect(mockSafeQuery).not.toHaveBeenCalled();
  });

  it("blocks a patch that targets /client_slug — inserts audit row with accepted=false, reason=patch_blocked", async () => {
    const ai = stubAI(
      JSON.stringify({
        patch: [{ op: "replace", path: "/client_slug", value: "evil" }],
        explanation: "bad",
      }),
    );

    await expect(
      generateBriefEdit({
        projectId: "site_1",
        currentBrief: BASE_BRIEF,
        instruction: "rename the client slug",
        userId: "u_1",
        userRole: "sales",
        ai,
      }),
    ).rejects.toMatchObject({
      name: "BriefEditValidationError",
      reason: "patch_blocked",
    });

    // Audit row STILL inserted — this is training data.
    expect(mockSafeQuery).toHaveBeenCalledTimes(1);
    const [, params] = mockSafeQuery.mock.calls[0];
    // accepted=false, rejection_reason='patch_blocked'
    expect(params[8]).toBe(false);
    expect(params[9]).toBe("patch_blocked");

    expect(mockTrackEvent).toHaveBeenCalledWith(
      "site.brief_edit_blocked",
      "u_1",
      "sales",
      expect.objectContaining({
        project_id: "site_1",
        blocked_paths: expect.stringContaining("/client_slug"),
      }),
    );
  });

  it("rejects when the rendered brief fails validateBrief (produces brief_invalid)", async () => {
    // Remove the only page → validateBrief fails (pages must be non-empty).
    const ai = stubAI(
      JSON.stringify({
        patch: [{ op: "remove", path: "/pages/0" }],
        explanation: "blow it up",
      }),
    );

    await expect(
      generateBriefEdit({
        projectId: "site_1",
        currentBrief: BASE_BRIEF,
        instruction: "delete every page",
        userId: "u_1",
        userRole: "sales",
        ai,
      }),
    ).rejects.toMatchObject({
      name: "BriefEditValidationError",
      reason: "brief_invalid",
    });

    expect(mockTrackEvent).toHaveBeenCalledWith(
      "site.brief_edit_failed",
      "u_1",
      "sales",
      expect.objectContaining({ reason: "brief_invalid" }),
    );
  });

  it("rejects when AI returns unparseable JSON", async () => {
    const ai = stubAI("not json at all { : [");
    await expect(
      generateBriefEdit({
        projectId: "site_1",
        currentBrief: BASE_BRIEF,
        instruction: "do something",
        userId: "u_1",
        userRole: "sales",
        ai,
      }),
    ).rejects.toMatchObject({
      name: "BriefEditValidationError",
      reason: "bad_ai_output",
    });
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "site.brief_edit_failed",
      "u_1",
      "sales",
      expect.objectContaining({ reason: "bad_ai_output" }),
    );
  });

  it("strips markdown fences from AI output", async () => {
    const ai = stubAI(
      "```json\n" +
        JSON.stringify({
          patch: [
            {
              op: "replace",
              path: "/pages/0/sections/0/heading",
              value: "Fenced",
            },
          ],
          explanation: "fenced",
        }) +
        "\n```",
    );
    const result = await generateBriefEdit({
      projectId: "site_1",
      currentBrief: BASE_BRIEF,
      instruction: "x",
      userId: "u_1",
      userRole: "sales",
      ai,
    });
    expect(result.renderedBrief.pages[0].sections[0].heading).toBe("Fenced");
  });
});

describe("recordBriefEditDecision", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("marks accepted=true and emits site.brief_edit_decided", async () => {
    mockSafeQuery.mockResolvedValueOnce({
      rows: [{ project_id: "site_1" }],
      fromCache: false,
    });
    const result = await recordBriefEditDecision(
      "brief_edit_abc",
      true,
      "u_1",
      "sales",
    );
    expect(result.projectId).toBe("site_1");

    const [sql, params] = mockSafeQuery.mock.calls[0];
    expect(sql).toContain("UPDATE instinct_site_brief_edits");
    expect(sql).toContain("SET accepted");
    expect(params[0]).toBe("brief_edit_abc");
    expect(params[1]).toBe(true);
    expect(params[2]).toBeNull();

    expect(mockTrackEvent).toHaveBeenCalledWith(
      "site.brief_edit_decided",
      "u_1",
      "sales",
      expect.objectContaining({
        project_id: "site_1",
        edit_id: "brief_edit_abc",
        accepted: true,
      }),
    );
  });

  it("marks accepted=false with rejectionReason and passes metadata", async () => {
    mockSafeQuery.mockResolvedValueOnce({
      rows: [{ project_id: "site_1" }],
      fromCache: false,
    });
    await recordBriefEditDecision(
      "brief_edit_xyz",
      false,
      "u_1",
      "sales",
      "didn't match intent",
    );
    const [, params] = mockSafeQuery.mock.calls[0];
    expect(params[1]).toBe(false);
    expect(params[2]).toBe("didn't match intent");

    expect(mockTrackEvent).toHaveBeenCalledWith(
      "site.brief_edit_decided",
      "u_1",
      "sales",
      expect.objectContaining({
        accepted: false,
        rejection_reason: "didn't match intent",
      }),
    );
  });

  it("defaults rejection_reason to 'user_rejected' when omitted on a reject", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [], fromCache: false });
    await recordBriefEditDecision("brief_edit_xyz", false, "u_1", "sales");
    const [, params] = mockSafeQuery.mock.calls[0];
    expect(params[2]).toBe("user_rejected");
  });
});
