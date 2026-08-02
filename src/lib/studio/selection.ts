/**
 * The bridge between "the operator clicked this" and "the gate can change it".
 *
 * The preview runs in an iframe, so a selection arrives as a postMessage from
 * another window. That makes its payload untrusted in the ordinary web sense —
 * anything can postMessage at a window — and untrusted in the specific sense
 * this codebase has already been bitten by: a value that crosses a boundary and
 * is then used to build something is exactly how the scaffolder injection
 * worked. The measurements here end up in a style calculation rather than in
 * source code, so the blast radius is smaller, but the discipline is the same.
 *
 * Everything below is total: any shape of input produces either a valid
 * Selection or null. Nothing throws, because a malformed message from a
 * preview iframe must not take the studio down.
 */
import { ADJUSTABLE, type AdjustableToken } from "./style-intent";

export type SelectionPart = "heading" | "body" | "item" | "media" | "container";

export interface Selection {
  pageIndex: number;
  sectionIndex: number;
  sectionType: string;
  part: SelectionPart;
  /** Only known tokens, only finite numbers. */
  measured: Partial<Record<AdjustableToken, number>>;
}

const PARTS: readonly SelectionPart[] = ["heading", "body", "item", "media", "container"];

/**
 * Keep only the token names this system can act on, and only real numbers.
 *
 * Built with a null prototype and an explicit key allowlist. An object literal
 * from another window can carry `__proto__`, `constructor` or a getter that
 * throws, and `{...incoming}` would carry all of it into the studio's state.
 */
export function sanitizeMeasured(raw: unknown): Partial<Record<AdjustableToken, number>> {
  const out = Object.create(null) as Partial<Record<AdjustableToken, number>>;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  for (const token of Object.keys(ADJUSTABLE) as AdjustableToken[]) {
    // Own-property check, so an inherited value cannot masquerade as measured.
    if (!Object.prototype.hasOwnProperty.call(raw, token)) continue;
    const value = (raw as Record<string, unknown>)[token];
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    out[token] = value;
  }
  return out;
}

/**
 * Turn a validated `element.select` message into a Selection, or null.
 *
 * `isInstinctEditMessage` has already checked the envelope; this checks the
 * meaning. Both exist because the protocol module owns the message shape and
 * this module owns what the studio is willing to act on, and those are
 * different questions — a well-formed message pointing at section -1 is a
 * protocol success and a studio refusal.
 */
export function selectionFromMessage(msg: unknown): Selection | null {
  if (typeof msg !== "object" || msg === null) return null;
  const m = msg as Record<string, unknown>;
  if (m.type !== "element.select") return null;

  const pageIndex = Number(m.pageIndex);
  const sectionIndex = Number(m.sectionIndex);
  if (!Number.isInteger(pageIndex) || pageIndex < 0) return null;
  if (!Number.isInteger(sectionIndex) || sectionIndex < 0) return null;

  const part = String(m.part) as SelectionPart;
  if (!PARTS.includes(part)) return null;

  const sectionType = typeof m.sectionType === "string" ? m.sectionType : "";
  if (sectionType === "") return null;

  return { pageIndex, sectionIndex, sectionType, part, measured: sanitizeMeasured(m.measured) };
}

/**
 * The value a style change should step FROM.
 *
 * Returns null when the token was not measured, and the caller must refuse
 * rather than assume. Substituting a default here would step from a number
 * that is not on the operator's screen, and the change would land somewhere
 * they did not ask for — which is worse than a refusal they can act on.
 */
export function currentValueFor(selection: Selection, token: AdjustableToken): number | null {
  const value = selection.measured[token];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Which tokens this selection can actually be asked to change. */
export function adjustableTokensFor(selection: Selection): AdjustableToken[] {
  return (Object.keys(ADJUSTABLE) as AdjustableToken[]).filter((t) => currentValueFor(selection, t) !== null);
}

/**
 * Map the preview's existing editable-field vocabulary onto a selection part.
 *
 * The preview page already decorates each editable node with a `field`
 * ("heading", "body", "cta.label", "attribution", …) as part of the inline-edit
 * delegation it has had since Path C. Reusing that vocabulary means the click
 * emitter is a few lines on top of handlers that already exist, rather than a
 * second traversal with its own idea of what is selectable — two traversals
 * that disagree is how a click selects one thing and edits another.
 *
 * Unknown fields map to "container" rather than being dropped: an operator who
 * clicked something should get a selection, and the worst case is an inspector
 * offering only layout tokens.
 */
export function partForField(field: string): SelectionPart {
  if (field === "heading") return "heading";
  if (field === "body" || field === "attribution" || field === "quote" || field === "tagline") return "body";
  if (field.startsWith("cta.")) return "item";
  if (field === "image" || field === "media" || field === "backgroundImage") return "media";
  return "container";
}

/** A label for the inspector header, so the operator can see what is selected. */
export function describeSelection(selection: Selection): string {
  return `${selection.sectionType} · ${selection.part} (section ${selection.sectionIndex})`;
}

/**
 * Read the rendered values off a computed style.
 *
 * Takes a property READER rather than an element. A structural element type
 * that a real HTMLElement satisfies AND a test fake can implement does not
 * exist here — CSSStyleDeclaration carries methods, so it is not assignable to
 * a plain record — and widening the type until both fit would have meant
 * casting at the call site, which is where a type stops being a check.
 *
 * A reader is also closer to how CSS is actually queried: kebab-case property
 * names through getPropertyValue, which is the same API the spec-diff probe
 * uses. Measuring what is RENDERED is the point — a section can inherit its
 * type scale from the theme or carry a number over from a prototype
 * conversion, and only the rendered value tells you which.
 */
export function measureComputed(read: (property: string) => string): Partial<Record<AdjustableToken, number>> {
  const num = (v: string): number => Number.parseFloat(v);
  const fontSize = num(read("font-size"));
  const rawLineHeight = num(read("line-height"));

  return sanitizeMeasured({
    fontSize,
    // "normal" parses to NaN and is dropped by sanitizeMeasured, which is
    // right: an unset line-height has no value to step from. Expressed as a
    // ratio because that is what the scale is in.
    lineHeight: Number.isFinite(rawLineHeight) && Number.isFinite(fontSize) && fontSize > 0 ? rawLineHeight / fontSize : Number.NaN,
    letterSpacing: num(read("letter-spacing")),
    spaceY: num(read("padding-top")),
    spaceX: num(read("padding-left")),
    radius: num(read("border-top-left-radius")),
    maxWidth: num(read("max-width")),
  });
}
