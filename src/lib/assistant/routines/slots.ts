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

/**
 * The most one slot may contribute to a prompt.
 *
 * WHY THIS EXISTS, and why it did not seem to matter until now: on a workspace
 * with an empty mailbox and no deals, a slot holds a few hundred characters and
 * an unbounded stringify is invisible. On a client's real system a CRM holds
 * thousands of records and a mailbox holds thousands of messages, and the same
 * chain builds a prompt out of all of them.
 *
 * The cost of getting that wrong is not only money. A provider that truncates
 * an over-long prompt does it silently, and the model then reasons over a
 * partial list and answers with complete confidence: "three deals need
 * attention" when it saw twenty of five hundred. That is the failure this
 * product spends most of its design avoiding, arriving through the back door
 * at exactly the moment somebody first plugs us into their real data.
 */
const MAX_SLOT_CHARS = 4000;
/** Items kept from a list, before it is worth saying how many there were. */
const MAX_SLOT_ITEMS = 25;

/** One slot value, or one field of it, as text a tool parameter can hold. */
function render(value: unknown, field?: string): string {
  const target =
    field && value && typeof value === "object"
      ? (value as Record<string, unknown>)[field]
      : value;
  if (target === null || target === undefined) return "";
  if (typeof target === "string") return bound(target);
  if (typeof target === "number" || typeof target === "boolean") return String(target);

  /* A LIST IS TRIMMED BY ITEMS, NOT BY CHARACTERS, because "the first 25 of
     500" is a true sentence somebody can act on and "the first 4000
     characters" is a broken record ending mid-field. */
  if (Array.isArray(target)) {
    /* SHRINK BY ITEMS UNTIL IT FITS, then say how many survived.
     *
     * Capping the item count and then cutting the result to length defeats
     * both halves of the idea, which is what the volume test caught: records
     * carry real text, so twenty-five of them can exceed the character budget,
     * and the character cut then severs one mid-field AND removes the note
     * saying the list was shortened. The model is left with corrupt-looking
     * data and no idea it is partial, which is worse than either problem
     * alone.
     *
     * So the count comes down until the serialised body fits, and the note is
     * added afterwards where nothing can trim it away. */
    let kept = target.slice(0, MAX_SLOT_ITEMS);
    let body = safeStringify(kept);
    while (kept.length > 1 && body.length > MAX_SLOT_CHARS) {
      kept = kept.slice(0, Math.max(1, Math.floor(kept.length / 2)));
      body = safeStringify(kept);
    }
    if (kept.length === target.length && body.length <= MAX_SLOT_CHARS) return body;
    /* One record that is itself enormous still has to be cut, and says so. */
    if (body.length > MAX_SLOT_CHARS) return bound(body);
    return `${body}\n[showing the first ${kept.length} of ${target.length}]`;
  }

  /* Structured output reaches a model step as JSON, which is what a model can
     actually read, and reaches a tool parameter the same way rather than as
     "[object Object]" -- the failure that looks like a formatting nit right up
     until it is the body of an email. */
  return bound(safeStringify(target));
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

/**
 * Cut to length, and SAY SO.
 *
 * The marker is the point. A model handed a silently truncated list has no way
 * to know it is partial, and will describe it as though it were whole. Told
 * plainly that it is looking at part of something, it can say so in the answer,
 * which is the difference between a useful summary and a confident wrong one.
 */
function bound(text: string): string {
  if (text.length <= MAX_SLOT_CHARS) return text;
  return `${text.slice(0, MAX_SLOT_CHARS)}\n[cut short: this is the first ${MAX_SLOT_CHARS} characters of ${text.length}, so treat it as partial]`;
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
