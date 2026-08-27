/**
 * The 92% of answers the router never sees.
 *
 * The model router is a real chokepoint holding real controls: outbound
 * redaction, a response-safety inspector, a content policy gate, residency,
 * retention, the constitution, a signed ledger.
 *
 * It is also not in the path for most answers. Measured over ninety days,
 * 6,381 tool invocations against 577 model completions. The deterministic
 * path, which is the thing this product is sold on, had no governance on it
 * at all: it read documents out of the Brain and printed them, personal data
 * included.
 *
 * ai.response_redacted read ZERO for the life of the feature, and I reported
 * that as good news. It meant the redactor was standing where the traffic was
 * not.
 */

const mockTrack = jest.fn();
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: unknown[]) => mockTrack(...a) }));

import { gateAnswer } from "@/lib/assistant/answer-gate";

const base = { userId: "u1", userRole: "cto" };

beforeEach(() => jest.clearAllMocks());

describe("the deterministic paths, which had no gate at all", () => {
  it.each(["brain", "tool", "user_qa_cache", "page_facts"])(
    "%s answers are redacted",
    (source) => {
      const out = gateAnswer({
        ...base,
        source,
        text: "Contact a.person@example-dealer.com about the venue.",
      });
      expect(out.text).not.toContain("a.person@example-dealer.com");
      expect(out.removed).toContain("email");
    },
  );

  it("records the source, so a zero is answerable", () => {
    /* A count with no source cannot tell "covered and clean" from "nobody was
       looking at that path", which is the exact ambiguity that let this run
       for the life of the feature. */
    gateAnswer({ ...base, source: "brain", text: "reach me on another.person@example.com" });
    const meta = mockTrack.mock.calls[0][3];
    expect(meta.source).toBe("brain");
    expect(meta.removed).toBe("email");
  });

  it("names what it removed, so the caller can say so", () => {
    /* An answer that silently lost a value reads as the document being
       incomplete. Naming the removal is the difference between a redaction and
       a gap. */
    const out = gateAnswer({ ...base, source: "brain", text: "call 555-867-5309 or a@example.com" });
    expect(out.removed.length).toBeGreaterThan(0);
  });
});

describe("what it deliberately does not do", () => {
  it("leaves the model path alone, because the router already redacted it", () => {
    /* Redacting twice is harmless and double-counts, which would make the
       router's own numbers unreadable. */
    const text = "Contact a.person@example-dealer.com about the venue.";
    const out = gateAnswer({ ...base, source: "ai", text });
    expect(out.text).toBe(text);
    expect(mockTrack).not.toHaveBeenCalled();
  });

  it("does not touch an answer with nothing to remove", () => {
    const text = "Brand Ambassador 101 covers communication skills and customer engagement.";
    const out = gateAnswer({ ...base, source: "brain", text });
    expect(out.text).toBe(text);
    expect(out.removed).toEqual([]);
    /* No event either. An event per answer would drown the signal it exists
       to carry. */
    expect(mockTrack).not.toHaveBeenCalled();
  });

  it("survives an empty answer without throwing", () => {
    /* A gate that can turn a good answer into an error is a gate somebody
       removes. */
    expect(gateAnswer({ ...base, source: "tool", text: "" })).toEqual({ text: "", removed: [] });
  });
});

describe("coverage is structural, not diligent", () => {
  it("is applied by wrapping chat rather than at each return", async () => {
    /* chatInner has nineteen return points. Putting the gate on each is the
       sweep that misses four call sites, which this codebase has already done
       once this month. This asserts the wrapper exists, so a new return path
       is covered the day somebody writes it. */
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync(require.resolve("@/lib/assistant"), "utf8"),
    );
    expect(src).toMatch(/export async function chat\(\s*\.\.\.args: Parameters<typeof chatInner>/);
    expect(src).toMatch(/async function chatInner\(/);
  });
});
