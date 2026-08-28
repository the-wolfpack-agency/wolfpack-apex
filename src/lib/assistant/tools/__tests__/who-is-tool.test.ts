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

import { whoIsTool, matchRosterQuestion, isAutomationForTests } from "@/lib/assistant/tools/who-is-tool";

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

/**
 * "what does Jorge do" is the same question as "who is Jorge".
 *
 * A routing audit on 2026-08-26 found it reached no tool. People ask about a
 * colleague both ways, and the second is at least as common, because it is
 * what you say when you know the name and not the job.
 */
describe("asking what somebody does", () => {
  it.each([
    "what does Jorge do",
    "what does Ashley work on",
    "what does Nick Homyk focus on",
  ])("claims %s", (prompt) => {
    expect(whoIsTool.matchIntent!(prompt)).not.toBeNull();
  });

  /* THE SUBJECT MUST LOOK LIKE A NAME. A person lookup answering "what does
     this button do" is the confident wrong answer this codebase keeps
     finding, so the pattern requires a capitalised subject rather than any
     noun. */
  it.each([
    "what does this button do",
    "what does the contract say",
    "what does the SOW say",
    "what does it do",
  ])("leaves %s alone", (prompt) => {
    expect(whoIsTool.matchIntent!(prompt)).toBeNull();
  });

  it("still claims the plain form", () => {
    expect(whoIsTool.matchIntent!("who is Jorge")).not.toBeNull();
  });
});

/**
 * Questions about the whole team, not about one person.
 *
 * WHO_IS_RE is `who is (.{2,120})`, so "who is on the team" captured "on the
 * team" as somebody's name and the assistant answered "No one named 'on the
 * team' on the team roster". Absurd, on a completely reasonable question, and
 * one of the first things a new user types.
 *
 * The variants that fell through were worse. "who works here" reached the
 * answer cache and cited four SharePoint documents that had nothing to do with
 * the question. "who do we have in sales" reached a model, which read a
 * client's survey spreadsheet and presented that client's staff as our sales
 * team. A roster question that escapes the roster gets answered from whatever
 * documents happen to mention people.
 */
describe("roster questions", () => {
  it.each([
    "who is on the team",
    "who's on the team",
    "who is on our team",
    "who works here",
    "show me the team",
    "list our team",
  ])("recognises %s as a roster question", (q) => {
    expect(matchRosterQuestion(q)).not.toBeNull();
  });

  it("picks up the area when one was named", () => {
    expect(matchRosterQuestion("who do we have in sales")).toEqual({ area: "sales" });
    expect(matchRosterQuestion("who do we have in ops")).toEqual({ area: "ops" });
  });

  /* A real name lookup must still reach the person path, or fixing the roster
     question would break the question the tool was built for. */
  it.each(["who is Jorge", "who is Nick Homyk", "who is the CEO of Porsche"])(
    "leaves %s to the person lookup",
    (q) => {
      expect(matchRosterQuestion(q)).toBeNull();
    },
  );
});

/**
 * Machinery is not a colleague.
 *
 * Measured against the real roster: 11 of 19 active members are automation.
 * Seven copies of "E2E (automated tests)", a CI smoke account, a health bot,
 * and one called "TEST". Nobody asking who is on the team means "and your
 * continuous integration credentials".
 */
describe("what a roster answer leaves out", () => {
  const asMember = (name: string) => ({ name, email: "x@example.com" });

  it.each([
    "E2E (automated tests)",
    "E2E dev (automated tests)",
    "CI Smoke E2E",
    "AgenticQA Health Bot",
    "TEST",
  ])("treats %s as machinery", (name) => {
    expect(isAutomationForTests(asMember(name))).toBe(true);
  });

  /* Narrow and anchored, so it cannot hide a real person. */
  it.each([
    "Max Fuerst",
    "Alicia Zulker",
    "Nick Homyk",
    "Testa Rossi",
    "Roberta Bott",
  ])("leaves %s alone", (name) => {
    expect(isAutomationForTests(asMember(name))).toBe(false);
  });
});
