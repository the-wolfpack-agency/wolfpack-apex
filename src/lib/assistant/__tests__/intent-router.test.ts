import { classifyIntent, SELF_TOKEN } from "@/lib/assistant/intent-router";

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

  test.each([
    ["am I available this afternoon?", "afternoon_today"],
    ["am i free tomorrow", "tomorrow"],
    ["am I busy this morning?", "morning_today"],
    ["do I have any meetings today", "today"],
    ["do I have anything this afternoon", "afternoon_today"],
  ])("first-person availability: %s", (q, timeframe) => {
    const m = classifyIntent(q);
    expect(m.intent).toBe("calendar_availability");
    expect(m.slots.person).toBe(SELF_TOKEN);
    expect(m.slots.timeframe).toBe(timeframe);
    expect(m.confidence).toBeGreaterThanOrEqual(0.85);
  });

  test.each([
    ["what's on my calendar today", "today"],
    ["what is on my schedule tomorrow", "tomorrow"],
    ["whats on my agenda this week", "this_week"],
    ["what's my day look like today", "today"],
    ["what does my day look like tomorrow", "tomorrow"],
  ])("first-person schedule: %s", (q, timeframe) => {
    const m = classifyIntent(q);
    expect(m.intent).toBe("calendar_schedule");
    expect(m.slots.person).toBe(SELF_TOKEN);
    expect(m.slots.timeframe).toBe(timeframe);
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

  // Regression 2026-04-30: identical org-wide meeting questions burned
  // tokens twice because nothing matched and the cache was bypassed for
  // date-bound queries. Now they route to the meetings_on_date tool.
  test.each([
    "which meetings did wolfpack have on April 21, 2026?",
    "what meetings did we have on 2026-04-21",
    "meetings on 4/21/2026",
    "what meetings were on April 21",
    "any meetings yesterday",
  ])("meetings_on_date: %p", (q) => {
    const m = classifyIntent(q);
    expect(m.intent).toBe("meetings_on_date");
    expect(m.confidence).toBeGreaterThanOrEqual(0.8);
  });

  test("meeting question with no date stays unknown (don't hijack RAG)", () => {
    const m = classifyIntent("any meetings about the porsche pitch");
    expect(m.intent).not.toBe("meetings_on_date");
  });

  // Regression 2026-04-30 evening: "april 30th meetings?>" fell through
  // to the LLM because the regex required "which/what/any" or "on/at/for".
  // Production users asked it with bare "DATE meetings" and got
  // hallucinated "no meetings recorded" answers.
  test.each([
    "april 30th meetings?",
    "April 30th meetings",
    "April 29 2026 meetings",
    "meetings April 30",
    "show me meetings 2026-04-30",
  ])("bare date+meetings phrasing %p routes to meetings_on_date", (q) => {
    const m = classifyIntent(q);
    expect(m.intent).toBe("meetings_on_date");
  });

  test("is deterministic — no LLM call path involved", () => {
    const a = classifyIntent("Is Hoxsie busy this afternoon?");
    const b = classifyIntent("Is Hoxsie busy this afternoon?");
    expect(a).toEqual(b);
  });

  // Regression 2026-04-22: the live dashboard got "Action items are..."
  // (RAG on help docs) when a user asked "when are my meetings today?"
  // because none of the self-schedule regexes matched that phrasing.
  test.each([
    "when are my meetings today?",
    "when is my next meeting?",
    "what meetings do I have today?",
    "any meetings today?",
    "my meetings today",
  ])("first-person meeting phrasing %p routes to calendar_schedule", (q) => {
    const m = classifyIntent(q);
    expect(m.intent).toBe("calendar_schedule");
    expect(m.slots.person).toBeDefined();
  });
});
