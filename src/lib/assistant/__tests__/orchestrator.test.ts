/* eslint-disable @typescript-eslint/no-explicit-any */
const mockCalendar = jest.fn();
const mockBrain = jest.fn();
const mockMail = jest.fn();
const mockGoals = jest.fn();
const mockFinancials = jest.fn();

jest.mock("@/lib/assistant/tools/calendar-availability", () => ({
  runCalendarAvailability: (...a: any[]) => mockCalendar(...a),
}));
jest.mock("@/lib/assistant/tools/brain-history", () => ({
  runBrainHistory: (...a: any[]) => mockBrain(...a),
}));
jest.mock("@/lib/assistant/tools/mail-search", () => ({
  runMailSearch: (...a: any[]) => mockMail(...a),
}));
jest.mock("@/lib/assistant/tools/goals-lookup", () => ({
  runGoalsLookup: (...a: any[]) => mockGoals(...a),
}));
jest.mock("@/lib/assistant/tools/financials-metric", () => ({
  runFinancialsMetric: (...a: any[]) => mockFinancials(...a),
}));

import { tryToolAnswer } from "@/lib/assistant/orchestrator";

const CTX = { userId: "nick@wolfpack.dev", userRole: "cto" };

beforeEach(() => {
  mockCalendar.mockReset();
  mockBrain.mockReset();
  mockMail.mockReset();
  mockGoals.mockReset();
  mockFinancials.mockReset();
});

describe("tryToolAnswer — intent dispatch", () => {
  test("calendar_availability → calendar tool", async () => {
    mockCalendar.mockResolvedValue({
      person: "Hoxsie",
      timeframeLabel: "this afternoon",
      busy: true,
      events: [],
      answer: "Hoxsie has 2 meetings this afternoon.",
    });
    const out = await tryToolAnswer("Is Hoxsie busy this afternoon?", CTX);
    expect(out?.intent).toBe("calendar_availability");
    expect(out?.source).toBe("tool");
  });

  test("goals_lookup → goals tool", async () => {
    mockGoals.mockResolvedValue({
      northStar: null,
      okrs: [],
      answer: "North Star: not yet set.",
      source: "goals",
    });
    const out = await tryToolAnswer("what are our current OKRs?", CTX);
    expect(out?.intent).toBe("goals_lookup");
    expect(mockGoals).toHaveBeenCalledTimes(1);
  });

  test("financials_metric → financials tool, passes role through", async () => {
    mockFinancials.mockResolvedValue({
      metric: "revenue",
      value: 250000,
      answer: "Revenue for this quarter: $250,000.",
      source: "financials",
    });
    const out = await tryToolAnswer("what's our revenue this quarter?", CTX);
    expect(out?.intent).toBe("financials_metric");
    expect(mockFinancials).toHaveBeenCalledWith(
      expect.objectContaining({ userRole: "cto" }),
    );
  });

  test("mail_search → mail tool with from/topic slots + caller userId", async () => {
    mockMail.mockResolvedValue({
      matches: [],
      answer: "Found 1 email.",
      source: "mail",
    });
    await tryToolAnswer("find the email from James about Q2", CTX);
    expect(mockMail).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "nick@wolfpack.dev", from: "James" }),
    );
  });

  test("brain_history → brain tool", async () => {
    mockBrain.mockResolvedValue({
      subject: "Porsche engagement",
      hits: [],
      answer: "Top 2 Brain hits for Porsche engagement:",
      source: "brain",
    });
    const out = await tryToolAnswer(
      "how many days was our Porsche engagement last year?",
      CTX,
    );
    expect(out?.intent).toBe("brain_history");
  });

  test("unknown intent returns null (caller falls through to RAG)", async () => {
    const out = await tryToolAnswer("just saying hi", CTX);
    expect(out).toBeNull();
    expect(mockCalendar).not.toHaveBeenCalled();
    expect(mockGoals).not.toHaveBeenCalled();
    expect(mockFinancials).not.toHaveBeenCalled();
  });

  test("tool returning null is propagated as null (orchestrator doesn't fake a success)", async () => {
    mockCalendar.mockResolvedValue(null);
    expect(await tryToolAnswer("is Ghost busy this afternoon?", CTX)).toBeNull();
  });
});
