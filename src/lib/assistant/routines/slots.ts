/**
 * Slot substitution — how one step reads what an earlier step produced.
 *
 * The entire data-flow mechanism, deliberately: `{{inbox}}` in a parameter
 * means "whatever the step that wrote the inbox slot returned". No expressions,
 * no paths beyond one level, no formatting directives.
 *
 * WHY SO LITTLE
 *
 * Every capability added here is one a routine author can get wrong silently,
 * inside a chain that sends mail. A missing slot is the interesting case, and
 * this file's real job is making that case IMPOSSIBLE TO MISS rather than
 * quietly rendering "undefined" into somebody's draft reply.
 *
 * Pure: no clock, no I/O, no registry lookups.
 */

/** {{slot}} or {{slot.field}}, with optional inner whitespace. */
const REF = /\{\{\s*([a-z_][a-z0-9_]*)(?:\.([a-z_][a-z0-9_]*))?\s*\}\}/gi;

export class MissingSlotError extends Error {
  constructor(public readonly slot: string) {
    super(
      `This step reads {{${slot}}}, which no earlier step wrote. A routine that ` +
        `substitutes an empty value here would send a real message with a hole in it.`,
    );
    this.name = "MissingSlotError";
  }
}

/** Every slot a template depends on, in first-appearance order. */
export function referencedSlots(template: unknown): string[] {
  const found: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === "string") {
      /* A fresh regex per string: REF is /g, and a shared lastIndex across
         calls makes a matcher that finds a reference, then misses the next
         identical one. */
      for (const m of v.matchAll(new RegExp(REF.source, "gi"))) {
        if (!found.includes(m[1])) found.push(m[1]);
      }
      return;
    }
    if (Array.isArray(v)) return v.forEach(walk);
    if (v && typeof v === "object") return Object.values(v).forEach(walk);
  };
  walk(template);
  return found;
}

/** One slot value, or one field of it, as text a tool parameter can hold. */
function render(value: unknown, field?: string): string {
  const target =
    field && value && typeof value === "object"
      ? (value as Record<string, unknown>)[field]
      : value;
  if (target === null || target === undefined) return "";
  if (typeof target === "string") return target;
  if (typeof target === "number" || typeof target === "boolean") return String(target);
  /* Structured output reaches a model step as JSON, which is what a model can
     actually read, and reaches a tool parameter the same way rather than as
     "[object Object]" -- the failure that looks like a formatting nit right up
     until it is the body of an email. */
  try {
    return JSON.stringify(target);
  } catch {
    return "";
  }
}

/**
 * Substitute slot references throughout a value.
 *
 * Throws MissingSlotError when a referenced slot was never written. Failing the
 * step is right: the alternative is a chain that carries on with a hole in a
 * parameter and produces something confident and wrong.
 *
 * A WHOLE-STRING reference to a non-string slot keeps its TYPE. A tool whose
 * schema wants an array of ids must receive the array, and stringifying it
 * would fail zod validation one step later with a message about the wrong
 * thing.
 */
export function interpolate<T>(template: T, slots: Record<string, unknown>): T {
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      const whole = new RegExp(`^${REF.source}$`, "i").exec(v);
      if (whole) {
        const [, name, field] = whole;
        if (!(name in slots)) throw new MissingSlotError(name);
        const value = slots[name];
        if (!field) return value;
        return value && typeof value === "object"
          ? (value as Record<string, unknown>)[field]
          : undefined;
      }
      return v.replace(new RegExp(REF.source, "gi"), (_m, name: string, field?: string) => {
        if (!(name in slots)) throw new MissingSlotError(name);
        return render(slots[name], field);
      });
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = walk(val);
      return out;
    }
    return v;
  };
  return walk(template) as T;
}
