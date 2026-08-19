/**
 * Which questions the assistant answers out of the events table.
 *
 * Reported 2026-08-19: "/cheap what is the weather in NYC today?" was answered
 * with the top ten event types of the last seven days, using zero tokens. The
 * trigger was a `.includes()` over a word list containing "today", so any
 * question with a time word in it was intercepted before the model was asked.
 *
 * The first block is the reported bug and its neighbours. The second is the
 * substring class: "count" lives inside "account". The third is the questions
 * that SHOULD still be answered this way, because a fix that turns the feature
 * off is not a fix.
 */
import { isAnalyticsQuestion } from "@/lib/assistant";

describe("a time word is not an analytics question", () => {
  test.each([
    "what is the weather in NYC today?",
    "what's on my calendar today",
    "did anything break yesterday",
    "what happened last week",
    "what is the total for the Henderson invoice",
    "who is out today",
  ])("%j is not answered from the events table", (q) => {
    expect(isAnalyticsQuestion(q)).toBe(false);
  });
});

describe("a word inside another word is not a match", () => {
  test.each([
    "how do I change my account?",
    "that is totally fine",
    "discount codes for the launch",
  ])("%j is not answered from the events table", (q) => {
    expect(isAnalyticsQuestion(q)).toBe(false);
  });
});

describe("real usage questions still are", () => {
  test.each([
    "show me the analytics",
    "what are the usage stats",
    "what are the top events this week",
    "which feature is most used",
    "how many logins were there yesterday",
    "how many events did we record today",
  ])("%j is answered from the events table", (q) => {
    expect(isAnalyticsQuestion(q)).toBe(true);
  });
});

describe("counting alone is not enough", () => {
  /* "How many people are coming" is a question about people, and answering it
     with a list of event types is the failure this file exists for. */
  test.each(["how many people are coming", "how many clients do we have", "how much is the retainer"])(
    "%j is not answered from the events table",
    (q) => {
      expect(isAnalyticsQuestion(q)).toBe(false);
    },
  );
});
