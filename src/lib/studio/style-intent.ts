/**
 * Prompted style changes, as a validated token delta rather than as CSS.
 *
 * WHAT THIS IS FOR
 *
 * The studio needs "make this heading tighter" to work on the thing the
 * operator selected. The obvious implementation — ask a model for CSS and apply
 * it — is the one thing this codebase has now been bitten by twice: a generator
 * that turns model or operator text into code is a generator that ships
 * whatever that text says. wolfpack-site-template PR #1 was exactly that bug.
 *
 * So the model never writes CSS, and never writes JSX. It proposes a STYLE
 * INTENT: a named token, a direction, and a magnitude. This module decides
 * whether that intent is expressible, resolves it against the theme scale the
 * site already uses, and returns a delta. Anything it cannot express is
 * refused with a reason.
 *
 * That is the gate principle applied to design: the model proposes, the gate
 * decides, and the set of things it can decide is finite and enumerable. An
 * intent for a token that does not exist cannot become a style; a magnitude
 * outside the scale cannot become a value.
 *
 * Pure. No React, no DOM, no model call.
 */

/** The token families a prompted change is allowed to touch. */
export const ADJUSTABLE = {
  fontSize: { scale: [12, 14, 16, 18, 21, 24, 28, 32, 40, 48, 59, 72], unit: "px" },
  lineHeight: { scale: [1, 1.15, 1.25, 1.4, 1.5, 1.6, 1.75, 2], unit: "" },
  letterSpacing: { scale: [-0.02, -0.01, 0, 0.01, 0.02, 0.04, 0.08, 0.18], unit: "em" },
  spaceY: { scale: [0, 4, 8, 12, 16, 24, 32, 48, 64, 96, 128], unit: "px" },
  spaceX: { scale: [0, 4, 8, 12, 16, 24, 32, 48, 64, 96, 128], unit: "px" },
  radius: { scale: [0, 2, 4, 8, 12, 16, 24, 999], unit: "px" },
  maxWidth: { scale: [480, 640, 760, 900, 1080, 1190, 1440], unit: "px" },
} as const;

export type AdjustableToken = keyof typeof ADJUSTABLE;
export type Direction = "increase" | "decrease" | "set";

export interface StyleIntent {
  /** Which section the change applies to. */
  sectionIndex: number;
  token: AdjustableToken;
  direction: Direction;
  /**
   * How far to move along the scale, in steps. Ignored for "set".
   * A step, not a pixel value: the scale is the design system, and moving in
   * pixels is how a system becomes a pile of one-off numbers.
   */
  steps?: number;
  /** For "set": the exact scale value to land on. */
  value?: number;
}

export interface StyleDelta {
  sectionIndex: number;
  token: AdjustableToken;
  from: number;
  to: number;
  /** Ready to write into a style object or a CSS var. */
  cssValue: string;
}

export type IntentResult =
  | { ok: true; delta: StyleDelta }
  | { ok: false; reason: string; refusedBecause: "unknown-token" | "off-scale" | "no-change" | "bad-input" };

const MAX_STEPS = 3;

/** Nearest scale entry to a raw value: a site may carry a legacy number that is
 *  not on the scale, and refusing to adjust it would strand the operator. */
export function nearestOnScale(token: AdjustableToken, value: number): number {
  const { scale } = ADJUSTABLE[token];
  return scale.reduce((best, s) => (Math.abs(s - value) < Math.abs(best - value) ? s : best), scale[0]);
}

/**
 * Resolve an intent against the current value.
 *
 * `current` is what the section renders today. It does not have to be on the
 * scale — a conversion from a prototype often is not — so it is snapped to the
 * nearest entry before stepping. That keeps every prompted change landing ON
 * the system rather than drifting further off it.
 */
export function resolveIntent(intent: StyleIntent, current: number): IntentResult {
  const family = ADJUSTABLE[intent.token];
  if (!family) {
    return { ok: false, reason: `"${intent.token}" is not an adjustable token`, refusedBecause: "unknown-token" };
  }
  if (!Number.isFinite(current)) {
    return { ok: false, reason: "the current value could not be read", refusedBecause: "bad-input" };
  }

  const scale = family.scale as readonly number[];
  const from = nearestOnScale(intent.token, current);
  let to: number;

  if (intent.direction === "set") {
    if (intent.value == null || !Number.isFinite(intent.value)) {
      return { ok: false, reason: "set requires a value", refusedBecause: "bad-input" };
    }
    if (!scale.includes(intent.value)) {
      // The whole point: an arbitrary number is how a design system stops being
      // one. The nearest legal value is offered so the message is actionable.
      return {
        ok: false,
        reason: `${intent.value}${family.unit} is not on the ${intent.token} scale; nearest is ${nearestOnScale(intent.token, intent.value)}${family.unit}`,
        refusedBecause: "off-scale",
      };
    }
    to = intent.value;
  } else {
    const steps = Math.abs(Math.trunc(intent.steps ?? 1));
    if (steps === 0) return { ok: false, reason: "a change of zero steps is not a change", refusedBecause: "no-change" };
    if (steps > MAX_STEPS) {
      // A model asked for "much bigger" should not be able to jump the whole
      // scale in one turn. Bounded moves keep a prompted edit reviewable.
      return { ok: false, reason: `at most ${MAX_STEPS} steps at a time (asked for ${steps})`, refusedBecause: "off-scale" };
    }
    const i = scale.indexOf(from);
    const next = intent.direction === "increase" ? i + steps : i - steps;
    if (next < 0 || next >= scale.length) {
      return {
        ok: false,
        reason: `${intent.token} is already at the ${intent.direction === "increase" ? "top" : "bottom"} of the scale`,
        refusedBecause: "off-scale",
      };
    }
    to = scale[next];
  }

  if (to === from) return { ok: false, reason: "that is the value it already has", refusedBecause: "no-change" };
  return { ok: true, delta: { sectionIndex: intent.sectionIndex, token: intent.token, from, to, cssValue: `${to}${family.unit}` } };
}

/**
 * Parse whatever a model returned into an intent, or refuse it.
 *
 * Deliberately strict and deliberately small. A model that returns prose, CSS,
 * or a token outside the list gets a refusal rather than a best-effort
 * interpretation, because a best-effort interpretation of untrusted text is the
 * exact shape of the bug this design exists to avoid.
 */
export function parseIntent(raw: unknown): { ok: true; intent: StyleIntent } | { ok: false; reason: string } {
  if (typeof raw !== "object" || raw === null) return { ok: false, reason: "expected an object" };
  const r = raw as Record<string, unknown>;

  const token = String(r.token ?? "");
  if (!(token in ADJUSTABLE)) return { ok: false, reason: `token must be one of: ${Object.keys(ADJUSTABLE).join(", ")}` };

  const direction = String(r.direction ?? "");
  if (direction !== "increase" && direction !== "decrease" && direction !== "set") {
    return { ok: false, reason: "direction must be increase, decrease or set" };
  }

  const sectionIndex = Number(r.sectionIndex);
  if (!Number.isInteger(sectionIndex) || sectionIndex < 0) return { ok: false, reason: "sectionIndex must be a non-negative integer" };

  const intent: StyleIntent = { sectionIndex, token: token as AdjustableToken, direction };
  if (r.steps != null) intent.steps = Number(r.steps);
  if (r.value != null) intent.value = Number(r.value);
  return { ok: true, intent };
}

/** One line an operator reads before accepting the change. */
export function describeDelta(delta: StyleDelta): string {
  const unit = ADJUSTABLE[delta.token].unit;
  const direction = delta.to > delta.from ? "up" : "down";
  return `${delta.token} ${direction} from ${delta.from}${unit} to ${delta.to}${unit} on section ${delta.sectionIndex}`;
}
