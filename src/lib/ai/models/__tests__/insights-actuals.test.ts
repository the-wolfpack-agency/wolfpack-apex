/**
 * What the router page reports as spend.
 *
 * Reported 2026-08-19: "The page is showing 'without an estimate' which shows
 * we aren't even counting our output ... azure-gpt-4o-mini 12 calls, $0.00
 * estimated (12 without an estimate)".
 *
 * The estimate is optional by construction: a selection is priced only when the
 * caller passes token counts, and the assistant cannot, because before a model
 * answers nobody knows how long the answer will be. No amount of guessing at
 * selection time makes that number true.
 *
 * The real figure was already recorded and never read. `ai.completion` carries
 * the provider's own input_tokens, output_tokens and cost_usd for every call
 * that ran. These tests pin that it is what the page reports, and that a
 * selection which never completed is still counted as a decision rather than
 * being quietly dropped or reported as free.
 */
import { summarizeActuals, describeInsights, summarizeProtection } from "@/lib/ai/models/insights";

const row = (model: string, cost: string | null, inTok: string, outTok: string) => ({
  model,
  cost_usd: cost,
  input_tokens: inTok,
  output_tokens: outTok,
});

describe("summarizeActuals", () => {
  test("adds up real calls, real cost and real tokens per model", () => {
    const out = summarizeActuals([
      row("azure-gpt-4o-mini", "0.0021", "900", "300"),
      row("azure-gpt-4o-mini", "0.0019", "800", "250"),
      row("azure-deepseek-v3", "0.0400", "1200", "900"),
    ]);
    expect(out.get("azure-gpt-4o-mini")).toEqual({
      calls: 2,
      costUsd: 0.004,
      inputTokens: 1700,
      outputTokens: 550,
    });
    expect(out.get("azure-deepseek-v3")?.calls).toBe(1);
  });

  test("a row with no model is ignored rather than counted as an empty one", () => {
    expect(summarizeActuals([{ model: null, cost_usd: "1", input_tokens: "1", output_tokens: "1" }]).size).toBe(0);
  });

  test("an unparseable cost does not corrupt the total", () => {
    /* A provider that stops reporting cost must not turn the total into NaN,
       which would render as "$NaN" on the page. */
    const out = summarizeActuals([row("m", null, "10", "5"), row("m", "0.5", "10", "5")]);
    expect(out.get("m")?.costUsd).toBe(0.5);
    expect(out.get("m")?.calls).toBe(2);
  });
});

describe("the headline sentence", () => {
  test("reports MEASURED spend when there is any", () => {
    const line = describeInsights({
      totalDecisions: 29,
      smallTierShare: 0.9,
      fallbacks: 0,
      decisionsWithoutEstimate: 17,
      actualCalls: 12,
      actualCostUsd: 0.0431,
      outputTokens: 5400,
    });
    expect(line).toContain("12 calls completed and cost $0.04 in measured spend");
    expect(line).toContain("5,400 output tokens generated");
    // The apology is gone: we have the real number, so we say the real number.
    expect(line).not.toContain("understates");
  });

  test("says so plainly when NOTHING completed, which is a worse problem", () => {
    const line = describeInsights({
      totalDecisions: 5,
      smallTierShare: null,
      fallbacks: 0,
      decisionsWithoutEstimate: 5,
    });
    expect(line).toContain("no completed calls recorded");
  });

  test("nothing recorded at all is not dressed up as activity", () => {
    expect(
      describeInsights({ totalDecisions: 0, smallTierShare: null, fallbacks: 0, decisionsWithoutEstimate: 0 }),
    ).toContain("nothing to measure");
  });
});

/**
 * Reported 2026-08-19: every model on the page read "no completed call
 * recorded", while calls were plainly being made.
 *
 * My bug, and a specific one: I joined the selection event to the completion
 * event on two identifiers that are not the same vocabulary. A selection
 * records the REGISTRY id ("azure-gpt-4o-mini"); a completion records
 * response.model_used, which for Azure is the DEPLOYMENT name ("gpt-4o-mini").
 * Nothing matched, so every row reported zero calls.
 *
 * The completion event already carries `selected_model_id`, the registry id,
 * recorded so the two routers are joinable. The query reads that first.
 */
describe("actual spend joins to the model that was selected", () => {
  test("a registry id matches, so the calls are attributed", () => {
    const out = summarizeActuals([
      { model: "azure-gpt-4o-mini", cost_usd: "0.002", input_tokens: "900", output_tokens: "300" },
    ]);
    expect(out.get("azure-gpt-4o-mini")?.calls).toBe(1);
  });

  test("a deployment name does NOT masquerade as a registry id", () => {
    /* The pre-fix shape: the row exists, carries real money, and simply does
       not belong to "azure-gpt-4o-mini". It must not be silently credited to
       it, and it must not vanish either: the caller totals every row. */
    const out = summarizeActuals([
      { model: "gpt-4o-mini", cost_usd: "0.002", input_tokens: "900", output_tokens: "300" },
    ]);
    expect(out.get("azure-gpt-4o-mini")).toBeUndefined();
    expect(out.get("gpt-4o-mini")?.costUsd).toBe(0.002);
    // Whatever it is called, the spend is still counted somewhere.
    expect([...out.values()].reduce((sum, a) => sum + a.costUsd, 0)).toBe(0.002);
  });
});

/**
 * What the router kept in.
 *
 * The gate has redacted credentials and financial identifiers at the last point
 * before a prompt leaves this process for a long time, on every completion,
 * whichever model answers. It has never been shown anywhere: the same failure
 * as the cost, where the evidence existed and nothing read it.
 *
 * The ordering of the two numbers is the design. Coverage is the claim a client
 * is buying and it stays true on a quiet week; findings are the proof it is not
 * decorative. A "blocked: 3" headline would read as a weak product when it
 * actually means people pasted few secrets.
 */
describe("summarizeProtection", () => {
  test("counts calls with findings and the items withheld", () => {
    const p = summarizeProtection(
      [
        { redacted_count: "2", kinds: "api_key,ssn" },
        { redacted_count: "1", kinds: "api_key" },
      ],
      120,
    );
    expect(p.callsChecked).toBe(120);
    expect(p.callsWithFindings).toBe(2);
    expect(p.itemsWithheld).toBe(3);
    // Most common kind first, so the panel names the real risk first.
    expect(p.kinds[0]).toEqual({ kind: "api_key", count: 2 });
  });

  test("what a model quoted BACK is counted apart from what a question carried", () => {
    const p = summarizeProtection(
      [{ redacted_count: "1", kinds: "api_key" }],
      50,
      [{ redacted_count: "2", kinds: "api_key,credit_card" }],
    );
    expect(p.itemsWithheld).toBe(1);
    expect(p.itemsWithheldFromAnswers).toBe(2);
    // Both directions share one kind list: "an API key was involved" is the
    // fact worth reading, and two lists of the same words help nobody.
    expect(p.kinds.map((k) => k.kind).sort()).toEqual(["api_key", "credit_card"]);
    expect(p.callsWithFindings).toBe(2);
  });

  test("no findings is a clean result, not a missing one", () => {
    /* The good outcome, and it must read as such: the check ran on every call
       and found nothing that should not leave. */
    const p = summarizeProtection([], 80);
    expect(p).toEqual({
      callsChecked: 80,
      callsWithFindings: 0,
      itemsWithheld: 0,
      /* The return path counts separately: an answer that quoted a credential
         is a different event from a question that carried one, and they have
         different fixes. */
      itemsWithheldFromAnswers: 0,
      kinds: [],
    });
  });

  test("an unparseable count does not corrupt the total", () => {
    const p = summarizeProtection([{ redacted_count: null, kinds: "api_key" }], 5);
    expect(p.itemsWithheld).toBe(0);
    expect(p.callsWithFindings).toBe(1);
  });

  test("only the KIND is ever summarised, which is all the gate stores", () => {
    /* The gate replaces values with placeholders and records kinds, by design,
       so this panel cannot leak what it caught even if somebody wanted it to. */
    const p = summarizeProtection([{ redacted_count: "1", kinds: "credit_card" }], 1);
    expect(JSON.stringify(p)).not.toMatch(/\d{4}/);
    expect(p.kinds).toEqual([{ kind: "credit_card", count: 1 }]);
  });
});
