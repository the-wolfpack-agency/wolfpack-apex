/**
 * Web posture - watch-first. Nothing is blocked in monitor mode; only a decoy
 * trip escalates to block in enforce mode; a weak hint is never blocked.
 */
import { decideWebAction } from "../posture";
import type { WebVerdict } from "../classify";

const v = (over: Partial<WebVerdict>): WebVerdict => ({ class: "normal", reason: "r", signal: "none", ...over });

it("monitor mode NEVER blocks, even on a decoy trip (watch-first)", () => {
  const d = decideWebAction(v({ class: "trapped", signal: "high" }), "monitor");
  expect(d.blocked).toBe(false);
  expect(d.action).toBe("report"); // recorded, not blocked
  expect(d.recorded).toBe(true);
});

it("enforce mode blocks a decoy trip - the one act-worthy signal", () => {
  const d = decideWebAction(v({ class: "trapped", signal: "high" }), "enforce");
  expect(d.blocked).toBe(true);
  expect(d.action).toBe("block");
});

it("a suspicious hint is reported but NEVER blocked, in either posture", () => {
  for (const posture of ["monitor", "enforce"] as const) {
    const d = decideWebAction(v({ class: "suspicious", signal: "info" }), posture);
    expect(d.action).toBe("report");
    expect(d.blocked).toBe(false);
    expect(d.recorded).toBe(true);
  }
});

it("a known agent is welcomed, never blocked", () => {
  for (const posture of ["monitor", "enforce"] as const) {
    const d = decideWebAction(v({ class: "known_agent", matchedAgentId: "a" }), posture);
    expect(d.action).toBe("welcome");
    expect(d.blocked).toBe(false);
  }
});

it("a normal visitor is allowed with nothing recorded", () => {
  const d = decideWebAction(v({ class: "normal" }), "enforce");
  expect(d.action).toBe("allow");
  expect(d.blocked).toBe(false);
  expect(d.recorded).toBe(false);
});
