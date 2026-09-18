/**
 * The "no execution data lost" ratchet. Asserts every ENFORCING control on the
 * ladder is classified in the capture map (captured, structurally recordless, or
 * a tracked gap), that no classification is self-contradictory, and that the
 * number of capture gaps only shrinks. A new enforcing control that emits an
 * execution stream cannot ship without either wiring it into the evidence
 * pipeline or explicitly recording why it is not captured yet.
 */
import { CAPTURE_MAP, captureGaps, enforcingLadderIds } from "../coverage";

// Ratchet: this may only ever go DOWN. Lower it when a gap is wired to a source.
const MAX_CAPTURE_GAPS = 4;

it("classifies every enforcing ladder control exactly once", () => {
  const ids = CAPTURE_MAP.map((c) => c.id);
  // No duplicates.
  expect(new Set(ids).size).toBe(ids.length);
  // Exactly the enforcing set - no missing control, no stale id for a control
  // that is no longer enforcing.
  expect(new Set(ids)).toEqual(new Set(enforcingLadderIds()));
});

it("gives each classification exactly one disposition", () => {
  for (const c of CAPTURE_MAP) {
    const set = [c.capturedBy, c.noPerActionRecord, c.gap].filter(Boolean);
    expect(set.length).toBe(1); // captured XOR recordless XOR gap - never zero, never two
  }
});

it("every gap and every recordless entry states a reason", () => {
  for (const c of CAPTURE_MAP) {
    if (c.gap) expect(c.gap.length).toBeGreaterThan(20);
    if (c.noPerActionRecord) expect(c.noPerActionRecord.length).toBeGreaterThan(20);
  }
});

it("the count of uncaptured execution streams only shrinks", () => {
  // If this fails LOW, lower MAX_CAPTURE_GAPS to lock the win. If it fails HIGH,
  // an enforcing control's execution stream was added without capturing it.
  expect(captureGaps().length).toBeLessThanOrEqual(MAX_CAPTURE_GAPS);
});

it("the primary governance seam is captured (the biggest evidence + fine-tune body)", () => {
  const authorize = CAPTURE_MAP.find((c) => c.id === "ogiam-authorize-agent");
  expect(authorize?.capturedBy).toBe("governance");
});
