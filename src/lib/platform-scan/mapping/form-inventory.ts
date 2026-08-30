/**
 * Telling a system's furniture from its content.
 *
 * WHY THE FORM COUNT LIED. Mapping a real tenant on 2026-08-30 reported "94
 * forms" across 40 surfaces. Reading them, most were the same four things
 * repeated on every screen: the vendor's support-chat widget ("New Chat",
 * "Upload File", "Submit Prompt"), a "Connect Form" panel, and a payment
 * account chooser. The client's actual forms were a minority of the number
 * carrying their name.
 *
 * A report that says 94 when the answer is closer to a dozen is worse than one
 * that says nothing, because somebody will quote it.
 *
 * THE SIGNAL IS REPETITION, NOT WORDING. A word list of known widgets would
 * need updating for every product we ever map. But furniture is on every
 * screen and content is not: a form appearing on nearly every surface is part
 * of the frame, whatever it is called. That rule needs no vocabulary and works
 * on systems nobody has seen yet.
 *
 * IT SEPARATES, IT DOES NOT DELETE. Chrome is still reported, as chrome. A
 * support widget that uploads files IS a data entry point, and a reader
 * assessing where information leaves an organisation should see it. What they
 * should not see is it counted eleven times alongside the invoice form.
 */

import type { MappedForm } from "./types";

/** A form and the surfaces it was seen on. */
export interface FormSighting {
  form: MappedForm;
  surfaces: string[];
}

export interface FormInventory {
  /** Forms belonging to the system being mapped. */
  content: FormSighting[];
  /** Forms that are part of the application frame, on most or every screen. */
  chrome: FormSighting[];
}

/**
 * How much of the estate a form must appear on before it is furniture.
 *
 * Two thirds. A genuine form sometimes appears twice, on a list and a detail
 * screen, and occasionally on a handful. Nothing real is on two thirds of an
 * estate except the frame.
 */
export const CHROME_SHARE = 2 / 3;

/** Below this there is no "most screens" to speak of and everything is content. */
const MIN_SURFACES_TO_JUDGE = 6;

/** Same name, same method, same fields is the same form seen twice. */
function identityOf(form: MappedForm): string {
  const fields = form.fields
    .map((f) => `${f.name}:${f.type}`)
    .sort()
    .join(",");
  return `${form.name}|${form.method}|${fields}`;
}

/**
 * Group forms across surfaces, and split the furniture from the content.
 *
 * Takes surfaces rather than a flat list, because the whole judgement is about
 * how widely a form is spread and that is lost the moment they are flattened.
 */
export function inventoryForms(
  surfaces: Array<{ signature: string; forms: MappedForm[] }>,
): FormInventory {
  const byIdentity = new Map<string, FormSighting>();

  for (const surface of surfaces) {
    /* A form repeated on ONE surface is one sighting there: a page with three
       identical rows of the same inline form has not tripled anything. */
    const seenHere = new Set<string>();
    for (const form of surface.forms) {
      const id = identityOf(form);
      const existing = byIdentity.get(id);
      if (existing) {
        if (!seenHere.has(id)) existing.surfaces.push(surface.signature);
      } else {
        byIdentity.set(id, { form, surfaces: [surface.signature] });
      }
      seenHere.add(id);
    }
  }

  const all = [...byIdentity.values()];
  if (surfaces.length < MIN_SURFACES_TO_JUDGE) {
    return { content: all, chrome: [] };
  }

  const threshold = surfaces.length * CHROME_SHARE;
  return {
    content: all.filter((s) => s.surfaces.length < threshold),
    chrome: all.filter((s) => s.surfaces.length >= threshold),
  };
}
