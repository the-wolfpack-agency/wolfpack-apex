/**
 * The ratchet. This test turns "which agent capabilities are still only
 * advisory or unwired" from an opinion into a number CI enforces. The count of
 * NON-ENFORCING controls may only shrink: wiring a control up the ladder means
 * lowering MAX_GAPS, never raising it. Adding a new capability at a low rung
 * without a plan fails the build.
 */
import {
  CONTROL_LADDER,
  gaps,
  isEnforcing,
  byRung,
  RUNG_ORDER,
  type ControlRung,
} from "../control-ladder";

/**
 * The number of controls not yet enforcing at a live seam. LOWER THIS as gaps
 * are closed; it must never be raised. Today's gaps: forcefield-containment
 * mcp-drift-inline (admin scan only), conduct-truthfulness (inherently
 * non-deterministic), budget-ceiling-unconfigured (fails open when no budget set).
 */
const MAX_GAPS = 3;

const RUNGS: ControlRung[] = ["structural", "deterministic-gate", "containment", "human-in-loop", "advisory"];

describe("agent control ladder", () => {
  it("every entry is fully specified", () => {
    for (const e of CONTROL_LADDER) {
      expect(e.id.trim().length).toBeGreaterThan(0);
      expect(e.capability.trim().length).toBeGreaterThan(10);
      expect(e.seam.trim().length).toBeGreaterThan(0);
      expect(e.file.trim().length).toBeGreaterThan(0);
      expect(RUNGS).toContain(e.rung);
      expect(typeof e.wired).toBe("boolean");
    }
  });

  it("has no duplicate ids", () => {
    const ids = CONTROL_LADDER.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("RATCHET: the number of non-enforcing controls may only shrink", () => {
    // If this fails high, a control regressed or a new low-rung capability was
    // added without wiring it. If it fails low, lower MAX_GAPS to lock the win.
    expect(gaps().length).toBeLessThanOrEqual(MAX_GAPS);
  });

  it("every non-enforcing control names the concrete gate that moves it up", () => {
    for (const e of gaps()) {
      expect(e.gateToMoveUp && e.gateToMoveUp.trim().length).toBeGreaterThan(20);
    }
  });

  it("an enforcing control is a rung 2+ control wired at a live seam", () => {
    for (const e of CONTROL_LADDER) {
      if (isEnforcing(e)) {
        expect(e.wired).toBe(true);
        expect(RUNG_ORDER[e.rung]).toBeGreaterThan(RUNG_ORDER.advisory);
      }
    }
    // Advisory is never enforcing, whatever else is true of it.
    for (const e of byRung("advisory")) expect(isEnforcing(e)).toBe(false);
  });

  it("the core tool-authorization gates are present and enforcing (registry cannot be gutted)", () => {
    const enforcingIds = new Set(CONTROL_LADDER.filter(isEnforcing).map((e) => e.id));
    for (const id of ["ogiam-authorize-agent", "capability-gate", "connector-scope", "agent-ceiling", "code-security-gate"]) {
      expect(enforcingIds.has(id)).toBe(true);
    }
  });

  it("the enforced conduct gate is enforcing; the truthfulness residual is honestly still a gap", () => {
    const gapIds = new Set(gaps().map((e) => e.id));
    // Forcefield containment (wired) and the new conduct self-tamper gate enforce.
    expect(gapIds.has("forcefield-containment")).toBe(false);
    const selfTamper = CONTROL_LADDER.find((e) => e.id === "conduct-self-tamper")!;
    expect(isEnforcing(selfTamper)).toBe(true);
    // Truthfulness cannot be a pre-execution gate; it is honestly still advisory.
    expect(gapIds.has("conduct-truthfulness")).toBe(true);
    // The old catch-all conduct entry is gone (split into enforced + residual).
    expect(CONTROL_LADDER.some((e) => e.id === "agent-conduct")).toBe(false);
  });
});
