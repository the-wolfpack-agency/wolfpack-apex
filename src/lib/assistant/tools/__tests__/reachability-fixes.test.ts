/**
 * Two tools nobody could reach by saying what they wanted.
 *
 * Measured 2026-08-27 across all 52 human-facing tools: 45 were reachable by
 * an ordinary sentence. The gap was never "most of the product is
 * undiscoverable"; it was seven specific tools, and two of them failed for
 * reasons worth pinning so they cannot come back.
 *
 * COMPARE_ACROSS_SOURCES matters most. Reading the same object out of two
 * connected systems and reporting where they disagree IS the middleware
 * argument. The plainest sentence for it, "where do the two systems
 * disagree", reached no tool at all, for two separate regex reasons stacked
 * on each other.
 */

import "@/lib/assistant/tools";
import { getTools } from "@/lib/assistant/tools/registry";

function claimants(message: string): string[] {
  return (getTools() as unknown as Array<{ name: string; agentOnly?: boolean; matchIntent?: (m: string) => unknown }>)
    /* agentOnly tools never fire on a human turn. */
    .filter((t) => !t.agentOnly && typeof t.matchIntent === "function" && t.matchIntent(message) != null)
    .map((t) => t.name);
}

describe("scanning an HR document", () => {
  /* The noun had to follow "scan" immediately, so "scan license" worked and
     every way a person actually says it did not. */
  it.each([
    "scan this HR document",
    "scan a license",
    "scan my passport",
    "scan the passport",
    "scan hr doc",
  ])("%s reaches scan_hr_doc", (prompt) => {
    expect(claimants(prompt)).toContain("scan_hr_doc");
  });

  it.each(["scan receipt", "scan invoice", "scan this receipt"])(
    "%s still goes to its own tool, not the HR one",
    (prompt) => {
      /* Widening a determiner is exactly how a matcher starts eating its
         neighbours' sentences. */
      expect(claimants(prompt)).not.toContain("scan_hr_doc");
    },
  );
});

describe("asking where two systems disagree", () => {
  /* TWO stacked regex bugs, both invisible without trying the sentence:
     1. Alternation is ORDERED. `the` sat before `the two`, so "the two
        systems" matched `the`, then required " systems" and met " two
        systems".
     2. `\s+` after "disagree" was mandatory, so the form with no object noun
        needed a trailing space to match. */
  it.each([
    "where do the two systems disagree",
    "where do our systems disagree",
    "where do both systems disagree",
    "where do the systems disagree",
    "where do our systems disagree about deals",
    "compare our contacts across systems",
  ])("%s reaches compare_across_sources", (prompt) => {
    expect(claimants(prompt)).toContain("compare_across_sources");
  });

  it("defaults to contacts when no object is named", async () => {
    /* Every connected system holds contacts, and the handler reports which
       systems it actually compared, so a wrong default is visible rather than
       silent. Requiring the noun made the product's central claim unreachable
       by its own sentence. */
    const { compareAcrossSourcesTool } = await import(
      "@/lib/assistant/tools/compare-across-sources-tool"
    );
    const params = compareAcrossSourcesTool.matchIntent!("where do the two systems disagree");
    expect(params).toMatchObject({ objectType: "contacts" });
  });

  it.each(["compare our revenue", "what did we bill Porsche", "how is the pilot going"])(
    "%s does not get claimed by it",
    (prompt) => {
      expect(claimants(prompt)).not.toContain("compare_across_sources");
    },
  );
});

describe("the reachability floor", () => {
  /* A RATCHET, like routing-coverage. Measured 45 of 52 on 2026-08-27; these
     two fixes make 47. It can only go up, and it goes up in the change that
     earns it. */
  const CORE = [
    ["how is the pilot going", "pilot_status"],
    ["what does the SOW say", "search"],
    ["what are my tasks", "task_list_widget"],
    /* Owned by get_calendar_availability, not the widget. "What is on my
       calendar today" is a free/busy question; "show me my calendar" is a
       request for the grid. Asserting the real owner rather than the one I
       assumed. */
    ["what's on my calendar today", "get_calendar_availability"],
    ["what does my week look like", "calendar_widget"],
    ["good morning", "good_morning_widget"],
    ["scan this HR document", "scan_hr_doc"],
    ["where do the two systems disagree", "compare_across_sources"],
    ["show me cross-tool insights", "cross_tool_insights_widget"],
    ["upload a document to the brain", "upload_to_brain"],
    ["what's the weather in Boston", "weather"],
  ] as const;

  it.each(CORE)("%s reaches %s", (prompt, tool) => {
    expect(claimants(prompt)).toContain(tool);
  });
});
