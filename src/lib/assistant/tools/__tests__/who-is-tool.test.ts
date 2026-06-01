/**
 * who_is — team-roster lookup with CRM-fallback.
 *
 * Locks the bug from the May 18 demo prep session:
 *   "who is Nick Homyk?" → must NOT return "No contact matches found
 *   in the configured CRM."
 *
 * The tool checks instinct_team_members first, falls back to the CRM
 * connector only when there's no internal match, and surfaces a clean
 * miss message when both fail (never the bare "no CRM contact" line).
 */

const mockSafeQuery = jest.fn();
const mockTrackEvent = jest.fn();
const mockPickConfigured = jest.fn();
const mockBuildRest = jest.fn();

jest.mock("@/lib/db", () => ({
  safeQuery: (...a: unknown[]) => mockSafeQuery(...a),
}));
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: unknown[]) => mockTrackEvent(...a),
}));
jest.mock("@/lib/assistant/connectors", () => ({
  pickConfiguredConnector: (...a: unknown[]) => mockPickConfigured(...a),
  buildRestConnectorForWorkspace: (...a: unknown[]) => mockBuildRest(...a),
}));

import { whoIsTool } from "@/lib/assistant/tools/who-is-tool";

const CTX = {
  userId: "u1",
  userRole: "cto",
  workspaceId: "ws-1",
  workflowId: "wf-1",
};

beforeEach(() => {
  mockSafeQuery.mockReset();
  mockTrackEvent.mockReset();
  mockPickConfigured.mockReset();
  mockBuildRest.mockReset();
  process.env.DATABASE_URL = "postgres://test";
});

describe("who_is intent matching", () => {
  test.each([
    "who is Nick Homyk",
    "who is Nick Homyk?",
    "who is hoxsie@thewolfpack.agency?",
    "who is the new CTO",
  ])("'%s' matches", (q) => {
    expect(whoIsTool.matchIntent!(q)).not.toBeNull();
  });

  test.each([
    "what are our OKRs",
    "find contacts named Nick",
    "create email",
    "who",
  ])("'%s' does NOT match", (q) => {
    expect(whoIsTool.matchIntent!(q)).toBeNull();
  });

  test("strips trailing punctuation from the query", () => {
    const p = whoIsTool.matchIntent!("who is Nick Homyk??");
    expect(p?.query).toBe("Nick Homyk");
  });
});

describe("who_is handler — team-first", () => {
  test("returns roster info when the team has a match", async () => {
    mockSafeQuery.mockResolvedValue({
      rows: [
        {
          id: "tm-1",
          name: "Nick Homyk",
          email: "homyk@thewolfpack.agency",
          role: "cto",
        },
      ],
    });

    const r = await whoIsTool.handler({ query: "Nick Homyk" }, CTX);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.source).toBe("team");
    expect(r.data.matchCount).toBe(1);
    expect(r.answer).toMatch(/Nick Homyk is on the team/);
    expect(r.answer).toMatch(/homyk@thewolfpack\.agency/);
    /* Critically: we never reached the CRM connector. */
    expect(mockBuildRest).not.toHaveBeenCalled();
    expect(mockPickConfigured).not.toHaveBeenCalled();
  });

  test("multiple team matches → numbered list", async () => {
    mockSafeQuery.mockResolvedValue({
      rows: [
        { id: "tm-1", name: "Nick Homyk", email: "homyk@x.co", role: "cto" },
        { id: "tm-2", name: "Nick Hoxsie", email: "nick@x.co", role: "ceo" },
      ],
    });

    const r = await whoIsTool.handler({ query: "Nick" }, CTX);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.matchCount).toBe(2);
    expect(r.answer).toMatch(/Found 2 team members/);
    expect(r.answer).toMatch(/Nick Homyk/);
    expect(r.answer).toMatch(/Nick Hoxsie/);
  });

  test("fires analytics with outcome=team_hit", async () => {
    mockSafeQuery.mockResolvedValue({
      rows: [
        { id: "tm-1", name: "X Y", email: "x@y.com", role: "cto" },
      ],
    });
    await whoIsTool.handler({ query: "X Y" }, CTX);
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "assistant.tool_invoked",
      "u1",
      "cto",
      expect.objectContaining({
        tool: "who_is",
        outcome: "team_hit",
        match_count: 1,
      }),
    );
  });
});

describe("who_is handler — CRM fallback", () => {
  test("falls back to CRM when team misses, surfaces CRM hit", async () => {
    mockSafeQuery.mockResolvedValue({ rows: [] });
    mockPickConfigured.mockResolvedValue("salesforce");
    mockBuildRest.mockResolvedValue({
      isConfigured: () => true,
      searchRecords: jest.fn().mockResolvedValue({
        ok: true,
        data: [{ Name: "External Contact", Email: "ext@vendor.com" }],
      }),
    });

    const r = await whoIsTool.handler({ query: "External Contact" }, CTX);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.source).toBe("crm");
    expect(r.data.matchCount).toBe(1);
    expect(r.answer).toMatch(/Found 1 CRM contact/);
    expect(r.answer).toMatch(/External Contact/);
    expect(r.answer).toMatch(/ext@vendor\.com/);
  });

  test("CRM miss + team miss → clean message naming both surfaces", async () => {
    mockSafeQuery.mockResolvedValue({ rows: [] });
    mockPickConfigured.mockResolvedValue("salesforce");
    mockBuildRest.mockResolvedValue({
      isConfigured: () => true,
      searchRecords: jest.fn().mockResolvedValue({ ok: true, data: [] }),
    });

    const r = await whoIsTool.handler({ query: "Ghost Person" }, CTX);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.source).toBe("none");
    expect(r.answer).toMatch(/No one named "Ghost Person"/);
    expect(r.answer).toMatch(/team roster/);
    expect(r.answer).toMatch(/CRM/);
    /* Critically: must NOT be the bare "no contact in CRM" message
     * that started this whole bug. */
    expect(r.answer).not.toMatch(/^No contact matches found/);
  });

  test("CRM not configured → suggests connecting it instead of pretending it failed", async () => {
    mockSafeQuery.mockResolvedValue({ rows: [] });
    mockPickConfigured.mockResolvedValue(null);
    mockBuildRest.mockResolvedValue({
      isConfigured: () => false,
      searchRecords: jest.fn(),
    });

    const r = await whoIsTool.handler({ query: "Ghost Person" }, CTX);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.answer).toMatch(/connect Salesforce or HubSpot/i);
    /* The CRM connectors live on /settings (single page in this app).
       Previously asserted /settings/integrations from a sibling-product
       URL shape that never landed here. */
    expect(r.answer).toMatch(/\/settings\b/);
  });

  test("CRM throwing does not 500 the tool — still returns clean miss", async () => {
    mockSafeQuery.mockResolvedValue({ rows: [] });
    mockPickConfigured.mockResolvedValue("salesforce");
    mockBuildRest.mockRejectedValue(new Error("token expired"));

    const r = await whoIsTool.handler({ query: "Anyone" }, CTX);
    expect(r.ok).toBe(true);
  });
});

describe("regression: who_is + landing-page chip", () => {
  test("'who is Nick Homyk' against an empty team roster does NOT surface 'No contact matches found in the configured CRM'", async () => {
    /* The original bug. Locks the bad string out. */
    mockSafeQuery.mockResolvedValue({ rows: [] });
    mockPickConfigured.mockResolvedValue(null);
    mockBuildRest.mockResolvedValue({
      isConfigured: () => false,
      searchRecords: jest.fn(),
    });

    const r = await whoIsTool.handler({ query: "Nick Homyk" }, CTX);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.answer).not.toMatch(
      /No contact matches found for "Nick Homyk" in the configured CRM/,
    );
  });
});
