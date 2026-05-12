/**
 * page-facts — zero-token page-description priority.
 *
 * These tests pin:
 *   1. Every registered PAGE_FACTS entry matches three realistic user
 *      questions with confidence >= 0.6.
 *   2. Ambiguous questions resolve deterministically.
 *   3. Non-page questions return null so the main chain runs.
 *   4. Formatter output has the title, embedded markdown link, and
 *      ≥3 feature bullets.
 *   5. chat() integration returns source=page_facts and fires the
 *      assistant.page_facts_hit analytics event.
 */

 

// ---------------------------------------------------------------------------
// Mocks — must be defined before importing modules that pull them in.
// ---------------------------------------------------------------------------

const mockSearchKnowledge = jest.fn();
const mockSaveAnswer = jest.fn();
const mockTrackEvent = jest.fn();
const mockSafeQuery = jest.fn();

jest.mock("@/lib/knowledge", () => ({
  searchKnowledge: (...args: any[]) => mockSearchKnowledge(...args),
  saveAnswer: (...args: any[]) => mockSaveAnswer(...args),
}));

jest.mock("@/lib/analytics", () => ({
  trackEvent: (...args: any[]) => mockTrackEvent(...args),
}));

jest.mock("@/lib/db", () => ({
  query: jest.fn(),
  safeQuery: (...args: any[]) => mockSafeQuery(...args),
}));

jest.mock("@/lib/triple-write", () => ({
  tripleWriteKnowledge: jest.fn().mockResolvedValue(undefined),
  tripleWriteEvent: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("@/lib/neo4j", () => ({
  recordKnowledgeInteraction: jest.fn().mockResolvedValue(undefined),
}));

import {
  PAGE_FACTS,
  formatPageFactsAnswer,
  type PageFact,
} from "../page-facts";
import { matchPageFacts, _debugScoreAll } from "../page-facts-matcher";

// ---------------------------------------------------------------------------
// Round-trip: every domain, three realistic phrasings.
// ---------------------------------------------------------------------------

interface Probe {
  domain: string;
  questions: string[];
}

// Each domain gets: one "what is"/"tell me about", one bare name, and
// one domain-specific verb phrasing. All three must resolve to the
// same domain with confidence >= 0.6.
const PROBES: Probe[] = [
  {
    domain: "dashboard",
    questions: ["what is the dashboard", "Dashboard", "show me my morning briefing"],
  },
  {
    domain: "assistant",
    questions: ["what is the assistant", "Assistant", "how do I use the assistant"],
  },
  {
    domain: "calendar",
    questions: ["how do I use Calendar", "Calendar", "where is my calendar"],
  },
  {
    domain: "meetings",
    questions: [
      "tell me about the meetings page",
      "Meetings",
      "where do I find my meetings",
    ],
  },
  {
    domain: "knowledge",
    questions: [
      "what is the knowledge base",
      "Knowledge Base",
      "how do I add to the knowledge base",
    ],
  },
  {
    domain: "brain",
    questions: ["what is the brain", "Brain", "how do I upload a company doc"],
  },
  {
    domain: "people",
    questions: ["what is the people page", "People", "show me my contacts"],
  },
  {
    domain: "directory",
    questions: [
      "what is the directory",
      "Directory",
      "where is the team directory",
    ],
  },
  {
    domain: "tasks",
    questions: ["what is the tasks page", "Tasks", "how do I track a todo"],
  },
  {
    domain: "planner",
    questions: ["what is the planner", "Planner", "how do I build a weekly plan"],
  },
  {
    domain: "goals",
    questions: ["how do I track goals", "OKRs", "what are key results"],
  },
  {
    domain: "journal",
    questions: ["what is the journal", "Journal", "how do I write a daily note"],
  },
  {
    domain: "discussions",
    questions: [
      "what is the discussions page",
      "Discussions",
      "how do I start a thread",
    ],
  },
  {
    domain: "docs",
    questions: ["what is the docs page", "Docs", "how do I generate a document"],
  },
  {
    domain: "features",
    questions: [
      "what is the features page",
      "Features",
      "how do I submit a feature request",
    ],
  },
  {
    domain: "clients",
    questions: ["what is the clients page", "Clients", "show me my client accounts"],
  },
  {
    domain: "sites",
    questions: ["what is the sites page", "Sites", "how do I build a microsite"],
  },
  {
    domain: "hr",
    questions: ["what is the hr page", "HR", "where do I manage benefits"],
  },
  {
    domain: "financials",
    questions: [
      "what is the financials page",
      "Financials",
      "how do I see my revenue",
    ],
  },
  {
    domain: "emails",
    questions: ["what is the emails page", "Emails", "where is my inbox"],
  },
  {
    domain: "reports",
    questions: [
      "what is the reports page",
      "Reports",
      "how do I see my weekly report",
    ],
  },
  {
    domain: "analytics",
    questions: [
      "what is the analytics page",
      "Analytics",
      "show me the metrics dashboard",
    ],
  },
  {
    domain: "notifications",
    questions: [
      "what is the notifications page",
      "Notifications",
      "where are my alerts",
    ],
  },
  {
    domain: "settings",
    questions: [
      "what is the settings page",
      "Settings",
      "how do I connect Microsoft",
    ],
  },
  {
    domain: "admin",
    questions: ["what is the admin page", "Admin", "where is the admin panel"],
  },
];

describe("matchPageFacts — round trip across every page", () => {
  for (const probe of PROBES) {
    describe(`domain: ${probe.domain}`, () => {
      for (const q of probe.questions) {
        test(`resolves "${q}" to ${probe.domain}`, () => {
          const match = matchPageFacts(q);
          expect(match).not.toBeNull();
          // The expected domain and the match's domain agree. A few
          // pages share a route (emails/mailbox); any domain whose
          // PAGE_FACTS.route matches the expected route is acceptable.
          const expectedRoute = PAGE_FACTS[probe.domain].route;
          expect(match!.page.route).toBe(expectedRoute);
          expect(match!.confidence).toBeGreaterThanOrEqual(0.6);
        });
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Negative paths — questions that must NOT match any page.
// ---------------------------------------------------------------------------

describe("matchPageFacts — negative", () => {
  test("empty input returns null", () => {
    expect(matchPageFacts("")).toBeNull();
    expect(matchPageFacts("   ")).toBeNull();
  });

  test('"hello" returns null', () => {
    expect(matchPageFacts("hello")).toBeNull();
  });

  test('"what is the weather" returns null', () => {
    expect(matchPageFacts("what is the weather")).toBeNull();
  });

  test('"my tax return" returns null', () => {
    expect(matchPageFacts("my tax return")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Ambiguity tie-break — must be deterministic.
// ---------------------------------------------------------------------------

describe("matchPageFacts — ambiguity tie-break", () => {
  test('"goals and tasks" picks one deterministically across 100 calls', () => {
    const domains = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const m = matchPageFacts("goals and tasks");
      expect(m).not.toBeNull();
      domains.add(m!.page.domain);
    }
    // Exactly one domain must be chosen; no randomness allowed.
    expect(domains.size).toBe(1);
    // On a true tie, alphabetical-first wins: "goals" < "tasks".
    expect([...domains][0]).toBe("goals");
  });

  test("scoreAllDomains surfaces both candidates for multi-page questions", () => {
    const candidates = _debugScoreAll("how do i manage goals and tasks");
    const picked = new Set(candidates.map((c) => c.page.domain));
    expect(picked.has("goals")).toBe(true);
    expect(picked.has("tasks")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Formatter — output shape contract.
// ---------------------------------------------------------------------------

describe("formatPageFactsAnswer", () => {
  test("contains title, route embedded as markdown link, and ≥3 feature bullets", () => {
    const fact: PageFact = PAGE_FACTS.calendar;
    const out = formatPageFactsAnswer(fact);

    expect(out).toContain(`**${fact.title}**`);
    // Markdown link — the route appears as `(/route)` somewhere in the
    // output so detectRelatedPagesFromExchange picks it up.
    expect(out).toContain(`(${fact.route})`);

    // At least three bullet lines.
    const bulletLines = out.split("\n").filter((l) => l.startsWith("- "));
    expect(bulletLines.length).toBeGreaterThanOrEqual(3);

    // The "How to use it" block renders as an ordered list.
    expect(out).toContain("**How to use it**");
    expect(out).toMatch(/^1\. /m);
  });

  test("every registered PAGE_FACTS entry formats without throwing", () => {
    for (const key of Object.keys(PAGE_FACTS)) {
      const out = formatPageFactsAnswer(PAGE_FACTS[key]);
      expect(out.length).toBeGreaterThan(0);
      expect(out).toContain(PAGE_FACTS[key].title);
      expect(out).toContain(`(${PAGE_FACTS[key].route})`);
    }
  });

  test("related-pages line renders as inline markdown links", () => {
    const out = formatPageFactsAnswer(PAGE_FACTS.calendar);
    // Calendar → related: meetings, people, settings
    expect(out).toMatch(/\[Meetings\]\(\/meetings\)/);
    expect(out).toMatch(/\[People\]\(\/people\)/);
    expect(out).toMatch(/\[Settings\]\(\/settings\)/);
  });
});

// ---------------------------------------------------------------------------
// chat() integration — source=page_facts, analytics fired, DB written.
// ---------------------------------------------------------------------------

describe("chat() integration — page_facts priority", () => {
  let queryLog: { text: string; params: unknown[] }[] = [];

  beforeEach(() => {
    jest.clearAllMocks();
    queryLog = [];
    mockSearchKnowledge.mockResolvedValue([]);
    mockSaveAnswer.mockResolvedValue(null);
    mockSafeQuery.mockImplementation((text: string, params?: unknown[]) => {
      queryLog.push({ text, params: params || [] });
      // No recent conversation → chat() creates a new one.
      return Promise.resolve({ rows: [], fromCache: false });
    });
    delete process.env.ANTHROPIC_API_KEY;
  });

  test('answers "how do I use Calendar" from page_facts (zero tokens)', async () => {
    const { chat } = await import("@/lib/assistant");
    const result = await chat("how do I use Calendar", "u1", "dev");

    expect(result.source).toBe("page_facts");
    expect(result.tokensUsed).toBe(0);
    expect(result.response).toContain("(/calendar)");
    expect(result.response).toContain("**Calendar**");
    expect(result.conversationId).toBeTruthy();
  });

  test("fires assistant.page_facts_hit analytics event on hit", async () => {
    const { chat } = await import("@/lib/assistant");
    await chat("how do I use Calendar", "u1", "dev");

    expect(mockTrackEvent).toHaveBeenCalledWith(
      "assistant.page_facts_hit",
      "u1",
      "dev",
      expect.objectContaining({
        module: "assistant",
        domain: "calendar",
        confidence: expect.any(Number),
      }),
    );
  });

  test("fires system.ai_call_skipped with reason=page_facts_hit", async () => {
    const { chat } = await import("@/lib/assistant");
    await chat("Calendar", "u1", "dev");

    expect(mockTrackEvent).toHaveBeenCalledWith(
      "system.ai_call_skipped",
      "u1",
      "dev",
      expect.objectContaining({ reason: "page_facts_hit" }),
    );
  });

  test("does NOT fire page_facts_hit for a question that does not match any page", async () => {
    const { chat } = await import("@/lib/assistant");
    await chat("what's the weather today", "u1", "dev");

    const fired = mockTrackEvent.mock.calls.some(
      (c: any[]) => c[0] === "assistant.page_facts_hit",
    );
    expect(fired).toBe(false);
  });

  test("persists the assistant message with source=page_facts", async () => {
    const { chat } = await import("@/lib/assistant");
    await chat("how do I track goals", "u1", "dev");

    // A SQL insert for an assistant message with source=page_facts
    // must have landed.
    const assistantInsert = queryLog.find(
      (q) =>
        q.text.includes("INSERT INTO instinct_messages") &&
        Array.isArray(q.params) &&
        (q.params as unknown[]).includes("page_facts"),
    );
    expect(assistantInsert).toBeDefined();
  });
});
