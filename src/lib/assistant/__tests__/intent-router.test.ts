import { classifyIntent } from "@/lib/assistant/intent-router";

describe("classifyIntent (token-free)", () => {
  test.each([
    ["Is Hoxsie busy this afternoon?", "calendar_availability", "Hoxsie", "afternoon_today"],
    ["is nick free tomorrow", "calendar_availability", "nick", "tomorrow"],
    ["Is Meghan Burke available this morning?", "calendar_availability", "Meghan Burke", "morning_today"],
  ])("calendar_availability: %s", (q, intent, person, timeframe) => {
    const m = classifyIntent(q);
    expect(m.intent).toBe(intent);
    expect(m.slots.person.toLowerCase()).toBe(person.toLowerCase());
    expect(m.slots.timeframe).toBe(timeframe);
    expect(m.confidence).toBeGreaterThan(0.8);
  });

  test("calendar_schedule captures the person name", () => {
    const m = classifyIntent("what's on Hoxsie's calendar tomorrow");
    expect(m.intent).toBe("calendar_schedule");
    expect(m.slots.person.toLowerCase()).toContain("hoxsie");
  });

  test("financials keywords route to financials_metric", () => {
    expect(classifyIntent("what's our MRR this quarter?").intent).toBe("financials_metric");
    expect(classifyIntent("how much cash do we have?").intent).toBe("financials_metric");
  });

  test("goals keywords route to goals_lookup", () => {
    expect(classifyIntent("what are our current OKRs?").intent).toBe("goals_lookup");
    expect(classifyIntent("show me our north star").intent).toBe("goals_lookup");
  });

  test("mail_search extracts from + topic slots", () => {
    const m = classifyIntent("find the email from James about the Q2 retainer");
    expect(m.intent).toBe("mail_search");
    expect(m.slots.from?.toLowerCase()).toBe("james");
    expect(m.slots.topic?.toLowerCase()).toContain("q2");
  });

  test("history questions route to brain_history with confidence < 0.8", () => {
    const m = classifyIntent("how many days was our Porsche engagement last year?");
    expect(m.intent).toBe("brain_history");
    expect(m.slots.timeframe).toBe("last_year");
    expect(m.confidence).toBeLessThan(0.8); // RAG still wants a verify step
  });

  test("unrelated chat returns unknown", () => {
    const m = classifyIntent("just saying hi");
    expect(m.intent).toBe("unknown");
    expect(m.confidence).toBe(0);
  });

  test("is deterministic — no LLM call path involved", () => {
    const a = classifyIntent("Is Hoxsie busy this afternoon?");
    const b = classifyIntent("Is Hoxsie busy this afternoon?");
    expect(a).toEqual(b);
  });
});
