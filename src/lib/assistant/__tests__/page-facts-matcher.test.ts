import { matchPageFacts } from "@/lib/assistant/page-facts-matcher";

/**
 * Questions the sweep caught being answered with the wrong screen.
 *
 * Found by running the prompts a person actually types, 2026-08-26. Both
 * matched at full confidence because the page name genuinely appears in the
 * sentence, which is what makes this class of wrong answer so convincing.
 */
describe("questions that are not about a page", () => {
  /* THE REPORTED ONE. "pilot" is the word this business uses for its most
     important engagement, and it is also a page domain. Asked what was going
     wrong, the product described a dashboard. */
  it.each([
    "what's blocking the pilot",
    "what is blocking the pilot",
    "any blockers on the pilot",
    "what's at risk with the pilot",
  ])("declines %s rather than touring the pilot page", (q) => {
    expect(matchPageFacts(q)).toBeNull();
  });

  it.each([
    "who reports to me",
    "who owns the Porsche account",
    "who is on the pilot team",
  ])("declines %s rather than touring a page", (q) => {
    expect(matchPageFacts(q)).toBeNull();
  });

  /* NARROW ON PURPOSE. A question genuinely about the page must still work,
     or this guard has traded one wrong answer for another. */
  it.each([
    "open the pilot dashboard",
    "what is the phase one page",
    "what does the deployment playbook say",
    "how do I use reports",
    "show me the reports page",
  ])("still answers %s", (q) => {
    expect(matchPageFacts(q)).not.toBeNull();
  });
});
