/**
 * This page documents a real capability, so the test pins that the shape is
 * complete (every control carries all four plain-language beats) and that the
 * honest boundary is stated (the controls are real; the Palo Alto framing is not).
 */
import { CONTROLS, HEADLINE, SEAM, WHATS_REAL } from "@/lib/builds/ai-data-governance";

it("covers the data-path controls, each with all four beats", () => {
  expect(CONTROLS.length).toBeGreaterThanOrEqual(4);
  const names = CONTROLS.map((c) => c.name.toLowerCase()).join(" ");
  expect(names).toMatch(/redact/);
  expect(names).toMatch(/residency/);
  expect(names).toMatch(/retention/);
  for (const c of CONTROLS) {
    for (const field of [c.name, c.jargon, c.plain, c.stops, c.without]) expect(field.trim()).not.toBe("");
    expect(c.plain.length).toBeGreaterThan(50);
  }
});

it("keeps the framing + states the honest boundary (real capability, not a client)", () => {
  for (const s of [HEADLINE, SEAM]) expect(s.trim().length).toBeGreaterThan(30);
  expect(WHATS_REAL.length).toBeGreaterThanOrEqual(2);
  expect(WHATS_REAL.some((w) => /real|run/i.test(w))).toBe(true);
  expect(WHATS_REAL.some((w) => /concept|not a client/i.test(w))).toBe(true);
});
