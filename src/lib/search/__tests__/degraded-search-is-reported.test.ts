/**
 * Zero results has two causes and the reader is entitled to know which.
 *
 * "No results found" asserts that every source was searched and held nothing.
 * When a provider timed out that is untrue, and it is the worst kind of untrue:
 * confident, silent, and pointing somebody away from data that may be sitting
 * right there.
 *
 * Measured 2026-08-29 in production: the Teams channels provider ran at a p95
 * of 22,136ms against a 6,000ms fan-out budget. So it routinely did not answer,
 * and every one of those searches reported a clean empty Teams result set.
 *
 * The timeout was ALREADY detected and already recorded to analytics. The flag
 * was set on the provider run and then never read again, so the fix is not new
 * detection: it is carrying a fact that was already known to the one reader who
 * most needed it.
 */
import { summaryAnswerForTests as summaryAnswer } from "@/lib/assistant/tools/search";
import type { SearchResponse } from "@/lib/search/runSearch";

function res(over: Partial<SearchResponse> = {}): SearchResponse {
  return {
    results: [],
    took_ms: 10,
    counts: { chats: 0, channels: 0, emails: 0, calendar: 0, knowledge: 0, crm: 0, dms: 0 },
    degraded: [],
    ...over,
  };
}

describe("when nothing was found", () => {
  it("says so plainly when every provider actually answered", () => {
    expect(summaryAnswer("payment terms", res())).toBe('No results found for "payment terms".');
  });

  /* THE ASSERTION THAT MATTERS. */
  it("does not claim an empty result when a provider never answered", () => {
    const answer = summaryAnswer(
      "payment terms",
      res({ degraded: [{ provider: "Microsoft Teams channels", reason: "timed_out" }] }),
    );
    expect(answer).not.toBe('No results found for "payment terms".');
    expect(answer).toContain("Microsoft Teams channels");
    expect(answer).toContain("not a complete answer");
    /* Keeps the opening the 2026-05-19 zero-results eval guards: that path
       must answer from the tool rather than fall through to a model. */
    expect(answer).toContain("No results");
  });

  /* A reader who is told the answer is incomplete needs to know it is worth
     retrying, or they will take the empty result as final anyway. */
  it("tells the reader it is worth asking again", () => {
    const answer = summaryAnswer("x y", res({ degraded: [{ provider: "CRM", reason: "failed" }] }));
    expect(answer).toContain("asking again");
  });

  it("names every provider that did not answer, not just the first", () => {
    const answer = summaryAnswer(
      "q",
      res({
        degraded: [
          { provider: "CRM", reason: "failed" },
          { provider: "Microsoft Teams channels", reason: "timed_out" },
        ],
      }),
    );
    expect(answer).toContain("CRM");
    expect(answer).toContain("Microsoft Teams channels");
  });

  /* Timeout and failure differ to us and not to the person waiting: both mean
     this source was not searched. Leaking our word for it buys nothing. */
  it("does not make the reader care whether it timed out or failed", () => {
    const answer = summaryAnswer("q", res({ degraded: [{ provider: "CRM", reason: "timed_out" }] }));
    expect(answer).not.toMatch(/timed_out|timeout/i);
  });
});

describe("when something was found but a source was skipped", () => {
  const withHits = (degraded: SearchResponse["degraded"]) =>
    summaryAnswer(
      "onboarding",
      res({
        results: [{}, {}, {}] as SearchResponse["results"],
        counts: { chats: 0, channels: 0, emails: 0, calendar: 0, knowledge: 3, crm: 0, dms: 0 },
        degraded,
      }),
    );

  /* Partial results presented as complete is the same lie, quieter. Somebody
     who stops reading at "Found 3 results" never learns a source was skipped. */
  it("still says a source was skipped", () => {
    const answer = withHits([{ provider: "Microsoft Teams channels", reason: "timed_out" }]);
    expect(answer).toContain("Found 3 results");
    expect(answer).toContain("Microsoft Teams channels");
  });

  it("reads normally when nothing was skipped", () => {
    const answer = withHits([]);
    expect(answer).toContain("Found 3 results");
    expect(answer).not.toContain("did not answer");
  });
});
