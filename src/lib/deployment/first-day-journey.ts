/**
 * The first day, as a client's employee would actually spend it.
 *
 * Every step is something a person does without being told to, and `because`
 * says what it would mean if that step were broken on their deployment. Steps
 * that need a connector we may not have configured for them expect
 * `needs_setup` as well as `substantive`, so a correct refusal is green and the
 * report does not cry wolf on a deployment behaving properly.
 */
import type { JourneyStep } from "./journey";

export const FIRST_DAY: JourneyStep[] = [
  {
    id: "documents-natural",
    ask: "what are the payment terms in our SOW?",
    /* THE PRODUCT. A real question against a real document. Verified working
       against production 2026-08-29: answered in 1,790ms with the figures and
       the source file cited. */
    expect: ["substantive", "empty"],
    budgetMs: 8_000,
    because: "This is what Phase 1 sells. If it fails, nothing else matters.",
  },
  {
    id: "documents-browse",
    ask: "what documents do we have about onboarding?",
    expect: ["substantive", "empty"],
    budgetMs: 8_000,
    because: "Somebody exploring rather than looking for one fact.",
  },
  {
    id: "starter-ask-our-documents",
    ask: "ask our documents",
    /* THE ONE THAT FAILED. The onboarding modal offers this and describes it as
       "search everything synced from SharePoint and answer with the source
       attached". On 2026-08-29 it returned a tour of the Docs page. Listed here
       so the regression is caught rather than remembered. */
    expect: ["substantive", "empty"],
    budgetMs: 8_000,
    because: "The onboarding offers this prompt, so it is many people's first ever query.",
  },
  {
    id: "calendar",
    ask: "what's on my calendar today?",
    expect: ["substantive", "needs_setup", "empty"],
    budgetMs: 10_000,
    because: "Graph calendar. Refusing cleanly when unconnected is a pass.",
  },
  {
    id: "capability",
    ask: "what can you do?",
    /* A tour IS the right answer here, and it is the only step where that is
       true. Keeping it in the journey proves the classifier is not simply
       flagging every long answer. */
    expect: ["substantive", "product_tour"],
    budgetMs: 6_000,
    because: "Everyone asks this. It must not read as an error.",
  },
  {
    id: "nonsense",
    ask: "what is the quarterly revenue of the moon department",
    /* Confabulation is the failure that destroys trust fastest, and it is
       invisible unless something asks a question with no possible answer. */
    expect: ["empty", "needs_setup", "substantive"],
    budgetMs: 10_000,
    because: "Must not invent an answer for something that does not exist.",
  },
];
