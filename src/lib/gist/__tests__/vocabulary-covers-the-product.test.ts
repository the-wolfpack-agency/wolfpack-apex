/**
 * The gist must be able to name every answer the product can give.
 *
 * WHY THIS IS THE RECIPROCAL CONTROL. The gist exists to compound: to learn
 * from decisions across engagements. A source it cannot name is a signal it
 * can never learn from, and nothing anywhere would have said so.
 *
 * MEASURED 2026-08-30. The gist declared six origins; the product declares
 * ten. user_qa_cache, analytics, meeting_transcripts and broadcast all
 * collapsed into "other" — 55 turns in the 90-day window, invisible as
 * themselves. The gist was quietly losing resolution on real traffic.
 *
 * That is the same shape as every defect this codebase has fixed today: two
 * different things spelled the same way. Here it is four different things
 * spelled "other".
 *
 * So the product's own union is the source of truth and this test is the
 * ratchet. Add a source to AssistantSource and this fails until the gist can
 * name it, which is the correct order: the product decides what it does, and
 * the gist keeps up.
 */

import { readFileSync } from "node:fs";
import { VOCABULARY } from "@/lib/gist/features";

/** Parsed from the product rather than restated, so the two cannot drift. */
function declaredAnswerSources(): string[] {
  const src = readFileSync("src/lib/assistant.ts", "utf8");
  const decl = /export type AssistantSource =([\s\S]*?);/.exec(src);
  if (!decl) throw new Error("AssistantSource union not found in src/lib/assistant.ts");
  return Array.from(decl[1].matchAll(/"([a-z_]+)"/g)).map((m) => m[1]).sort();
}

describe("the gist can name every source the product can produce", () => {
  it("finds the product's union, so this cannot pass by parsing nothing", () => {
    expect(declaredAnswerSources().length).toBeGreaterThanOrEqual(8);
  });

  it("declares an origin for each one", () => {
    const missing = declaredAnswerSources().filter((s) => !VOCABULARY.origin.includes(s as never));
    expect(
      missing.length === 0
        ? "every source is nameable"
        : `these sources would collapse into "other": ${missing.join(", ")}`,
    ).toBe("every source is nameable");
  });

  /* "other" must remain, so a source added to the product degrades rather than
     throwing at runtime. The test above is what stops it staying degraded. */
  it("keeps a catch-all, so a new source degrades rather than breaks", () => {
    expect(VOCABULARY.origin).toContain("other");
  });

  /* And the reverse: an origin the gist names that the product cannot produce
     is dead vocabulary, which reads as coverage and is not. */
  it("does not name origins the product cannot produce", () => {
    const declared = new Set(declaredAnswerSources());
    const orphans = VOCABULARY.origin.filter((o) => o !== "other" && !declared.has(o));
    expect(
      orphans.length === 0 ? "no orphans" : `gist names sources the product cannot emit: ${orphans.join(", ")}`,
    ).toBe("no orphans");
  });
});

/**
 * THE OTHER HALF, WHICH WAS MISSING AND COST 187 TURNS.
 *
 * The source guardrail above parses a union out of the product, so a new
 * SOURCE cannot silently degrade. Outcomes had no equivalent, because the gist
 * inferred them from the answer's prose and there was no union to parse.
 *
 * That gap was not theoretical. On 2026-08-30 it cost 14 outage answers read
 * as neutral and 187 model-written refusals read as ordinary answers, and both
 * were found by hand rather than by a test.
 *
 * The product now DECLARES the kind at the point it answers, so this can hold
 * the two in step exactly the way sources are held. Add a kind to
 * AnswerOutcomeKind and this fails until the gist can act on it.
 */
function declaredOutcomeKinds(): string[] {
  const src = readFileSync("src/lib/assistant.ts", "utf8");
  const decl = /export type AnswerOutcomeKind =([\s\S]*?);/.exec(src);
  if (!decl) throw new Error("AnswerOutcomeKind union not found in src/lib/assistant.ts");
  return Array.from(decl[1].matchAll(/"([a-z_]+)"/g)).map((m) => m[1]).sort();
}

/**
 * Kinds the gist handles WITHOUT giving them an outcome of their own, and why.
 * Named here rather than silently accepted, so the choice is visible.
 */
const HANDLED_WITHOUT_OWN_OUTCOME: Record<string, string> = {
  answered:
    "the ordinary case; what happened next decides the outcome, not the answer itself",
  nothing_found:
    "becomes dead_end or pushed_past depending on whether the person came back",
  low_confidence:
    "the answer was still shown, so the outcome is whatever the person did next",
  not_connected:
    "a missing integration, which is an onboarding gap rather than an answer quality one",
};

describe("the gist can act on every outcome the product declares", () => {
  it("finds the product's union, so this cannot pass by parsing nothing", () => {
    expect(declaredOutcomeKinds().length).toBeGreaterThanOrEqual(5);
  });

  it("has a plan for each declared kind", () => {
    const unhandled = declaredOutcomeKinds().filter(
      (k) => !VOCABULARY.outcome.includes(k as never) && !(k in HANDLED_WITHOUT_OWN_OUTCOME),
    );
    expect(
      unhandled.length === 0
        ? "every declared kind is handled"
        : `the gist does not know what to do with: ${unhandled.join(", ")}`,
    ).toBe("every declared kind is handled");
  });

  /* Every exemption must carry a reason somebody can argue with, which is what
     stops the allowlist becoming a place to hide a kind nobody wired up. */
  it.each(Object.entries(HANDLED_WITHOUT_OWN_OUTCOME))(
    "%s is exempt for a stated reason",
    (_kind, reason) => {
      expect(reason.length).toBeGreaterThan(30);
    },
  );

  /* And the reverse: an exemption for a kind the product no longer declares is
     stale, and reads as a decision somebody made when it is really a leftover. */
  it("has no exemptions for kinds the product no longer declares", () => {
    const declared = new Set(declaredOutcomeKinds());
    const stale = Object.keys(HANDLED_WITHOUT_OWN_OUTCOME).filter((k) => !declared.has(k));
    expect(stale.length === 0 ? "no stale exemptions" : `stale: ${stale.join(", ")}`).toBe(
      "no stale exemptions",
    );
  });
});
