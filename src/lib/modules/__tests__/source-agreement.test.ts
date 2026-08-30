/**
 * When several systems hold the same fact, answer from one and say when they
 * disagree.
 *
 * THE DECISION THIS PINS, MADE BEFORE DMS AND CRM LAND.
 *
 * Phase 1 has one source, so "which source" has never been a question. With
 * SharePoint, a CRM and one or more DMS connected, the same fact is usually
 * stated differently in each: the CRM has a deal value, the DMS has an order,
 * the contract has the terms.
 *
 * Merging them loses provenance, and a number a person cannot trace is a number
 * they will not act on. It also hides the interesting case: averaging $12,000
 * and $12,480 produces a figure that exists in neither system.
 *
 * So: answer from ONE source, cite it, and report disagreement separately.
 * Disagreement is a finding, not a failure to resolve, and every design that
 * quietly picks a winner destroys the most valuable sentence the product can
 * produce.
 */
import {
  resolveAcrossSources,
  describeAgreement,
  saysTheSame,
  type SourceAnswer,
} from "@/lib/modules/source-agreement";

const answer = (over: Partial<SourceAnswer> & Pick<SourceAnswer, "source">): SourceAnswer => ({
  value: "$12,000",
  confidence: 0.5,
  citation: "ref",
  ...over,
});

describe("choosing one source", () => {
  it("returns nothing when no source has an answer", () => {
    expect(resolveAcrossSources([])).toBeNull();
  });

  it("reports a single source as ordinary, not as a weakness", () => {
    const r = resolveAcrossSources([answer({ source: "documents" })])!;
    expect(r.agreement).toBe("single_source");
    expect(r.conflicts).toEqual([]);
  });

  /* Confidence is only comparable WITHIN a source, so this is a tie-break
     among candidates that already passed their own retriever's bar, never a
     cross-source score. */
  it("answers from the most confident candidate", () => {
    const r = resolveAcrossSources([
      answer({ source: "crm", confidence: 0.4 }),
      answer({ source: "documents", confidence: 0.9 }),
    ])!;
    expect(r.answer.source).toBe("documents");
  });

  it("is deterministic when confidence ties", () => {
    const once = resolveAcrossSources([answer({ source: "dms" }), answer({ source: "crm" })])!;
    const twice = resolveAcrossSources([answer({ source: "crm" }), answer({ source: "dms" })])!;
    expect(once.answer.source).toBe(twice.answer.source);
  });
});

describe("agreement between systems", () => {
  it("reports corroboration when they say the same thing", () => {
    const r = resolveAcrossSources([
      answer({ source: "documents", value: "$12,000", confidence: 0.9 }),
      answer({ source: "crm", value: "$12,000", confidence: 0.5 }),
    ])!;
    expect(r.agreement).toBe("corroborated");
    expect(r.agreedWith).toEqual(expect.arrayContaining(["documents", "crm"]));
  });

  /* THE CASE THE WHOLE MODULE EXISTS FOR. A client whose systems disagree
     needs to know that more than they need a confident single number. */
  it("reports a conflict rather than quietly picking a winner", () => {
    const r = resolveAcrossSources([
      answer({ source: "documents", value: "$12,480", confidence: 0.9 }),
      answer({ source: "crm", value: "$12,000", confidence: 0.5 }),
    ])!;
    expect(r.agreement).toBe("conflicting");
    expect(r.conflicts).toHaveLength(1);
    expect(r.conflicts[0]!.source).toBe("crm");
  });

  it("never drops the losing answer", () => {
    const r = resolveAcrossSources([
      answer({ source: "documents", value: "A", confidence: 0.9 }),
      answer({ source: "crm", value: "B", confidence: 0.5 }),
      answer({ source: "dms", value: "C", confidence: 0.1 }),
    ])!;
    expect(r.conflicts.map((c) => c.value).sort()).toEqual(["B", "C"]);
  });
});

describe("what counts as the same answer", () => {
  /* CONSERVATIVE ON PURPOSE. A false conflict is worse than a missed one: the
     first trains people to ignore the warning that matters, the second is
     caught by the reader. */
  it.each([
    ["$12,000", "12000"],
    ["$12,000.00", "12000"],
    ["12,000 USD", "12000 usd"],
    ["Net 30", "net 30"],
  ])("treats %s and %s as the same fact", (a, b) => {
    expect(saysTheSame(a, b)).toBe(true);
  });

  it.each([
    ["$12,000", "$12,480"],
    ["Net 30", "Net 60"],
  ])("treats %s and %s as different", (a, b) => {
    expect(saysTheSame(a, b)).toBe(false);
  });
});

describe("what a person reads", () => {
  it("names the source on a single-source answer", () => {
    const r = resolveAcrossSources([answer({ source: "documents", citation: "SOW.pdf" })])!;
    expect(describeAgreement(r)).toContain("your documents");
    expect(describeAgreement(r)).toContain("SOW.pdf");
  });

  it("says so when systems agree, which is genuinely reassuring", () => {
    const r = resolveAcrossSources([
      answer({ source: "documents", confidence: 0.9 }),
      answer({ source: "crm", confidence: 0.5 }),
    ])!;
    expect(describeAgreement(r)).toMatch(/agree/);
  });

  /* NAMES BOTH FIGURES. "Your systems disagree" without the numbers is a
     warning nobody can act on, and it sends somebody to check by hand, which
     is the work this product exists to remove. */
  it("gives both numbers and both sources on a conflict", () => {
    const r = resolveAcrossSources([
      answer({ source: "documents", value: "$12,480", confidence: 0.9, citation: "SOW.pdf" }),
      answer({ source: "crm", value: "$12,000", confidence: 0.5 }),
    ])!;
    const text = describeAgreement(r);
    expect(text).toContain("$12,480");
    expect(text).toContain("$12,000");
    expect(text).toContain("the CRM");
    expect(text).toMatch(/not been reconciled/);
  });

  /* It must not imply the product resolved something it did not. Deciding
     which system is authoritative is a business rule that differs per client
     and per field, and guessing at it is wrong expensively. */
  it("does not claim to have resolved the conflict", () => {
    const r = resolveAcrossSources([
      answer({ source: "documents", value: "A", confidence: 0.9 }),
      answer({ source: "crm", value: "B", confidence: 0.5 }),
    ])!;
    expect(describeAgreement(r).toLowerCase()).not.toMatch(/correct|authoritative|actually/);
  });
});
