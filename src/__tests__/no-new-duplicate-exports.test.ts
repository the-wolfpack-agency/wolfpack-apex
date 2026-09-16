/**
 * DRY ratchet: no NEW function/class is exported under a name that already
 * exists elsewhere in the repo. Born from this session, where a second gate
 * duplicated one already in src/lib/ai-code and only a manual scan caught it.
 *
 * A name collision is not proof of duplication, so today's collisions are
 * baselined and only a NEW one fails. When it fires, either reuse the existing
 * symbol (the point), or - if the new one is genuinely distinct - accept it with
 * `npm run scan:dup-exports -- --write` and commit the updated baseline.
 */
import { currentCollisions, loadBaseline } from "@/lib/dev/scan-duplicate-exports";

describe("no new duplicate function/class exports (DRY gate)", () => {
  const current = currentCollisions();
  const baseline = loadBaseline();

  it("introduces no NEW duplicate export name", () => {
    const added = Object.entries(current)
      .filter(([name]) => !(name in baseline))
      .map(([name, files]) => `  ${name} is already an exported function/class in: ${files.join(", ")}\n      Reuse it, or 'npm run scan:dup-exports -- --write' to accept.`);
    expect(added.length === 0 ? [] : added).toEqual([]);
  });

  it("adds no NEW file to an already-baselined duplicate name", () => {
    const grew = Object.entries(current)
      .filter(([name]) => name in baseline)
      .filter(([name, files]) => files.some((f) => !baseline[name].includes(f)))
      .map(([name, files]) => `  ${name} gained a new copy: ${files.filter((f) => !baseline[name].includes(f)).join(", ")}`);
    expect(grew.length === 0 ? [] : grew).toEqual([]);
  });

  it("has no STALE baseline entry, so the debt cannot be overstated", () => {
    const stale = Object.keys(baseline)
      .filter((name) => !(name in current))
      .map((name) => `  ${name} no longer collides — 'npm run scan:dup-exports -- --write' to prune it`);
    expect(stale.length === 0 ? [] : stale).toEqual([]);
  });
});
