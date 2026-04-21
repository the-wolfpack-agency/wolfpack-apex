/* eslint-disable @typescript-eslint/no-explicit-any */
const mockRunCalendarAvailability = jest.fn();

jest.mock("@/lib/assistant/tools/calendar-availability", () => ({
  runCalendarAvailability: (...a: any[]) => mockRunCalendarAvailability(...a),
}));

import { tryToolAnswer } from "@/lib/assistant/orchestrator";

beforeEach(() => {
  mockRunCalendarAvailability.mockReset();
});

describe("tryToolAnswer", () => {
  test("routes a 'is X busy' question into the calendar tool", async () => {
    mockRunCalendarAvailability.mockResolvedValue({
      person: "Hoxsie",
      timeframeLabel: "this afternoon",
      busy: true,
      events: [],
      answer: "Hoxsie has 2 meetings this afternoon.",
    });
    const out = await tryToolAnswer("Is Hoxsie busy this afternoon?");
    expect(out).not.toBeNull();
    expect(out!.intent).toBe("calendar_availability");
    expect(out!.source).toBe("tool");
    expect(mockRunCalendarAvailability).toHaveBeenCalledWith(
      expect.objectContaining({
        personName: "Hoxsie",
        timeframeToken: "afternoon_today",
      }),
    );
  });

  test("returns null when the calendar tool can't resolve the person", async () => {
    mockRunCalendarAvailability.mockResolvedValue(null);
    const out = await tryToolAnswer("Is Ghost busy this afternoon?");
    expect(out).toBeNull();
  });

  test("returns null for unknown-intent questions so caller falls back to RAG", async () => {
    const out = await tryToolAnswer("just saying hi");
    expect(out).toBeNull();
    expect(mockRunCalendarAvailability).not.toHaveBeenCalled();
  });

  test("returns null for other intents (they'll ship in follow-up commits)", async () => {
    expect(await tryToolAnswer("what's our MRR this quarter?")).toBeNull();
    expect(await tryToolAnswer("what are our current OKRs?")).toBeNull();
  });
});
