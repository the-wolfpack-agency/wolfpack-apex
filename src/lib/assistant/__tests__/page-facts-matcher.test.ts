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

/**
 * An instruction to search a corpus is not a question about a page.
 *
 * Found by driving the deployed product as a new user, 2026-08-29: "ask our
 * documents" returned a tour of the Docs page in 489ms at full confidence,
 * because "documents" is that page's own name. The onboarding modal OFFERS
 * that prompt and describes it as "search everything synced from SharePoint
 * and answer with the source attached", so it is many people's first ever
 * query and the first thing a client would see in a walkthrough.
 *
 * Nothing underneath it was broken. SharePoint was connected, search worked,
 * and the same intent phrased as "what are the payment terms in our SOW?"
 * answered from a real document with a citation in 1,790ms. Only the routing
 * was wrong, which is why no unit test and no health probe could see it.
 */
describe("a retrieval instruction never gets a page tour", () => {
  it.each([
    "ask our documents",
    "search our documents for the SOW",
    "look through the files for the invoice",
    "query my knowledge base",
    "ask all our docs about onboarding",
    "search the sharepoint",
  ])("declines %s and lets retrieval answer", (question) => {
    expect(matchPageFacts(question)).toBeNull();
  });

  /* Narrow on purpose. The verb has to govern the corpus, or this would
     swallow every question containing the word "documents" and break the
     page-facts feature it lives inside. */
  it.each([
    "where do I find the docs page",
    "open the documents page",
    "show me the docs tab",
  ])("still answers %s with the Docs page, because that really is about a page", (question) => {
    /* These asked about the SCREEN, so a tour is the correct answer and the
       guard must not swallow them. A rule that fired on every sentence
       containing "documents" would break the feature it lives inside. */
    expect(matchPageFacts(question)?.page.domain).toBe("docs");
  });

  /* The question that ALREADY worked must keep working, and the reason it
     worked is worth pinning because it is not the reason it looks like.
     It DOES match the Docs page, at 0.50, which is below the 0.6 confidence
     chat() acts on. So retrieval got it by a margin of one tenth rather than
     by any rule, and it answered in production with 4 real results.
     If page scoring ever nudges that above 0.6, this question starts
     returning a tour and nothing else would notice. */
  it("leaves a natural document question below the threshold chat acts on", () => {
    const m = matchPageFacts("what documents do we have about onboarding?");
    expect(m?.confidence ?? 0).toBeLessThan(0.6);
  });
});
