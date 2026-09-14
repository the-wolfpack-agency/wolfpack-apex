/**
 * The point of this build is reusability, so the test pins that the engine is
 * client-neutral and complete: the four beats, the ladder, the field track, and
 * a recipe for applying it to any client.
 */
import { APPLY, FIELD_TRACK, GATEKEEPING, LADDER, METHOD, REUSES, WORKED_EXAMPLES } from "@/lib/builds/plain-language-method";

it("keeps the four beats and a client-neutral ladder", () => {
  expect(METHOD.map((m) => m.beat)).toEqual([
    "Name the jargon", "Say what is happening", "What it stops", "What happens without it",
  ]);
  expect(LADDER.length).toBeGreaterThanOrEqual(3);
  for (const t of LADDER) for (const f of [t.tier, t.who, t.proves]) expect(f.trim()).not.toBe("");
});

it("carries the field track, the gatekeeping thesis, and the reuse", () => {
  expect(FIELD_TRACK.covers.length).toBeGreaterThanOrEqual(3);
  expect(GATEKEEPING).toMatch(/gatekeep/i);
  expect(REUSES.length).toBeGreaterThanOrEqual(3);
});

it("has a recipe for applying it to any client, and names a worked example", () => {
  expect(APPLY.length).toBeGreaterThanOrEqual(4);
  for (const a of APPLY) for (const f of [a.step, a.why]) expect(f.trim()).not.toBe("");
  expect(WORKED_EXAMPLES.some((e) => e.where === "/builds/security-plain-language")).toBe(true);
});
