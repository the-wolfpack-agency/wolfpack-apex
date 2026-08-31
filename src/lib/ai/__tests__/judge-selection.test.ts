/**
 * Independence, tested as independence.
 *
 * The failure this guards is silent agreement: a sibling model checking its
 * own family's work, passing it, and leaving a row in an audit log that says
 * "checked". That row is worse than no row, because a gap gets fixed and a
 * false reassurance gets cited. So the assertions below are mostly about
 * REFUSING to nominate a judge.
 */
import { lineageOf, chooseIndependentJudge, LINEAGE_UNKNOWN } from "../judge-selection";

describe("lineageOf", () => {
  it("reads the family from the model name", () => {
    expect(lineageOf({ model: "claude-haiku-4-5" })).toBe("anthropic");
    expect(lineageOf({ model: "gpt-4o-mini" })).toBe("openai");
    expect(lineageOf({ model: "llama-3.1-8b-instant" })).toBe("meta");
    expect(lineageOf({ model: "deepseek-v3" })).toBe("deepseek");
    expect(lineageOf({ model: "mixtral-8x7b" })).toBe("mistral");
  });

  it("sees through the door a model came in by", () => {
    /* THE CASE THIS MODULE EXISTS FOR. azure-gpt-4o and gpt-4o are the same
       weights reached two ways; judging one with the other would pass a
       provider-name check and be exactly the sibling review being prevented. */
    expect(lineageOf({ model: "azure-gpt-4o", provider: "azure" })).toBe("openai");
    expect(lineageOf({ model: "gpt-4o", provider: "openai" })).toBe("openai");
  });

  it("does not treat a reseller as a family", () => {
    /* Azure serves Llama and gpt-4o both. Calling "azure" a lineage would make
       those two siblings, which is false in the direction that silently blocks
       a legitimate independent check. */
    expect(lineageOf({ model: "llama-3.3-70b", provider: "azure" })).toBe("meta");
    expect(lineageOf({ provider: "azure" })).toBe(LINEAGE_UNKNOWN);
    expect(lineageOf({ provider: "groq" })).toBe(LINEAGE_UNKNOWN);
  });

  it("falls back to the provider only when the model says nothing", () => {
    expect(lineageOf({ provider: "anthropic" })).toBe("anthropic");
    expect(lineageOf({ model: "", provider: "openai" })).toBe("openai");
  });

  it("is unknown rather than guessed for a name it does not recognize", () => {
    expect(lineageOf({ model: "some-new-model-v1" })).toBe(LINEAGE_UNKNOWN);
    expect(lineageOf({})).toBe(LINEAGE_UNKNOWN);
  });
});

describe("chooseIndependentJudge", () => {
  const claude = { provider: "anthropic", model: "claude-haiku-4-5" };
  const gpt = { provider: "azure", model: "azure-gpt-4o" };
  const llama = { provider: "groq", model: "llama-3.1-8b-instant" };

  it("picks a different family", () => {
    const c = chooseIndependentJudge(claude, [gpt, llama]);
    expect(c.reason).toBe("independent");
    expect(c.candidate).toBe(gpt);
    expect(c.authorLineage).toBe("anthropic");
    expect(c.judgeLineage).toBe("openai");
  });

  it("REFUSES when every candidate is a sibling", () => {
    /* Falling back to a sibling and calling it a check is the whole failure
       mode. Better an honest gap. */
    const c = chooseIndependentJudge(claude, [
      { provider: "anthropic", model: "claude-sonnet-4-6" },
      { provider: "anthropic", model: "claude-opus-4-7" },
    ]);
    expect(c.candidate).toBeNull();
    expect(c.reason).toBe("no_independent_lineage_configured");
  });

  it("refuses when the same weights arrive by a second door", () => {
    // OpenAI's gpt-4o must not check Azure's gpt-4o.
    const c = chooseIndependentJudge(gpt, [{ provider: "openai", model: "gpt-4o" }]);
    expect(c.candidate).toBeNull();
    expect(c.reason).toBe("no_independent_lineage_configured");
  });

  it("refuses when there are no candidates at all", () => {
    expect(chooseIndependentJudge(claude, []).candidate).toBeNull();
  });

  it("refuses to judge an author whose family is unknown", () => {
    /* Unknown is not a family, so it cannot be shown to DIFFER from anything,
       and a check that cannot demonstrate independence must not be recorded as
       one. The fix is to teach the module the model name. */
    const c = chooseIndependentJudge({ provider: "mystery", model: "x-1" }, [claude]);
    expect(c.candidate).toBeNull();
    expect(c.reason).toBe("author_lineage_unknown");
  });

  it("skips candidates of unknown family rather than assuming they differ", () => {
    /* A candidate that MIGHT be a sibling is not evidence of independence.
       Passing it would let an unrecognized model name launder a sibling check. */
    const c = chooseIndependentJudge(claude, [{ provider: "mystery", model: "x-1" }, gpt]);
    expect(c.candidate).toBe(gpt);
  });

  it("prefers the first independent candidate, so the order is the policy", () => {
    // Callers order by cost, so this makes the cheapest independent judge win.
    const c = chooseIndependentJudge(claude, [llama, gpt]);
    expect(c.candidate).toBe(llama);
  });

  it("always reports both lineages, so the audit row can prove the claim", () => {
    const c = chooseIndependentJudge(claude, [gpt]);
    expect(c.authorLineage).not.toBe(c.judgeLineage);
    expect(c.judgeLineage).toBeTruthy();
  });
});
