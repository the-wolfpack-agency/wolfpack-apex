/**
 * Turning refusal events into the panel's answer to "what did you stop".
 *
 * The shape under test is deliberately awkward: the events store RULE IDS and
 * nothing else, because storing the blocked sentence would build a permanent,
 * queryable archive of exactly the text the gate withheld. So the summary has
 * to reconstruct readable reasoning from ids at read time, and these tests
 * pin the consequences of that choice.
 */
import { summarizeRefusals } from "@/lib/ai/models/insights";

const row = (action: string, rules: string, profile = "automotive") => ({
  action,
  rules,
  profile,
});

describe("summarizeRefusals", () => {
  it("counts the three outcomes apart", () => {
    /* Blocked and escalated both withhold, and the follow-up is different:
       one is a claim we will never make, the other is a person's job. */
    const s = summarizeRefusals([
      row("block", "price_guarantee"),
      row("block", "safety_assurance"),
      row("escalate", "warranty_coverage"),
      row("redact", "competitor_claim"),
    ]);
    expect(s.total).toBe(4);
    expect(s.blocked).toBe(2);
    expect(s.escalated).toBe(1);
    expect(s.redacted).toBe(1);
  });

  it("resolves a rule id to the reasoning a client can argue with", () => {
    const s = summarizeRefusals([row("block", "price_guarantee")]);
    expect(s.rules[0].title).toBe("Promised a price");
    expect(s.rules[0].why.length).toBeGreaterThan(40);
  });

  it("reads the CURRENT wording, so editing a rule fixes every past refusal", () => {
    /* The alternative, storing the explanation on the event, freezes a
       sentence at the moment it fired: correct a rule's reasoning and the
       history keeps citing the old one. */
    const s = summarizeRefusals([row("block", "price_guarantee")]);
    const { POLICY_PROFILES } = jest.requireActual("@/lib/ai/policy");
    const live = POLICY_PROFILES.baseline.find(
      (r: { id: string }) => r.id === "price_guarantee",
    );
    expect(s.rules[0].why).toBe(live.why);
  });

  it("still renders a rule that no longer exists", () => {
    /* Events are permanent; rule sets are not. Dropping the row would quietly
       shrink a historical total, and printing a bare id explains nothing. */
    const s = summarizeRefusals([row("block", "retired_rule")]);
    expect(s.rules[0].title).toBe("retired rule");
    expect(s.rules[0].why).toMatch(/no longer part of any active policy/i);
  });

  it("orders rules by how often they fire", () => {
    const s = summarizeRefusals([
      row("block", "price_guarantee"),
      row("escalate", "warranty_coverage"),
      row("block", "price_guarantee"),
    ]);
    expect(s.rules[0].rule).toBe("price_guarantee");
    expect(s.rules[0].count).toBe(2);
  });

  it("counts every rule on an answer that tripped several", () => {
    const s = summarizeRefusals([row("block", "price_guarantee,delivery_promise")]);
    expect(s.total).toBe(1);
    expect(s.rules.map((r) => r.rule).sort()).toEqual(["delivery_promise", "price_guarantee"]);
  });

  it("lists every rule set in play, for a deployment serving more than one tenant", () => {
    const s = summarizeRefusals([
      row("block", "price_guarantee", "automotive"),
      row("block", "invented_discount", "retail"),
      row("block", "price_guarantee", "automotive"),
    ]);
    expect(s.profiles).toEqual(["automotive", "retail"]);
  });

  it("reports an honest zero on an empty window rather than throwing", () => {
    const s = summarizeRefusals([]);
    expect(s).toEqual({ total: 0, blocked: 0, escalated: 0, redacted: 0, rules: [], profiles: [] });
  });

  it("tolerates a malformed row, because the event store is not a schema", () => {
    const s = summarizeRefusals([
      { action: null, rules: null, profile: null },
      row("block", ""),
    ]);
    expect(s.total).toBe(2);
    expect(s.rules).toEqual([]);
  });
});
