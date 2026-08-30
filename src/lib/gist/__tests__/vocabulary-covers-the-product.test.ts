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
