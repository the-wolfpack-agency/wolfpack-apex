/**
 * The people this workspace knows about, so their names can be kept off a page.
 *
 * The directory is already synced and already holds display names, so nothing
 * new is stored and nothing new is asked of the client. This reads it, splits
 * each name into the whole thing and the first part, and hands back a list the
 * display layer can match against.
 *
 * FIRST NAMES ARE INCLUDED AND THAT IS A TRADE. "Book me 30 minutes with dana"
 * carries a person as plainly as the full name does. The cost is that a common
 * first name doubling as a word gets masked in a sentence that did not mean a
 * person, so anything under four letters is left out: masking "an amy" is a
 * small ugliness, masking every "sam" in "same day" is a broken page.
 *
 * IT NEVER FAILS THE CALLER. A directory that cannot be read yields an empty
 * list, and the display layer still shortens, still drops statements and still
 * redacts. Masking is the last line of that defence rather than the only one,
 * which is what makes an empty list survivable.
 */

import { query } from "@/lib/db";

/** Below this a first name collides with ordinary words too often to mask. */
const MIN_FIRST_NAME = 4;

export async function getKnownNames(): Promise<string[]> {
  try {
    const { rows } = await query<{ name: string }>(
      `SELECT DISTINCT display_name AS name FROM instinct_directory_users
        WHERE display_name IS NOT NULL AND length(display_name) > 2
       UNION
       SELECT DISTINCT name FROM instinct_team_members
        WHERE name IS NOT NULL AND length(name) > 2`,
    );
    return buildNameList(rows.map((r) => r.name));
  } catch {
    /* silent-ok: an unreadable directory means no masking, which the display
       layer is built to survive. Failing the panel over it would hide the
       gaps a client actually asked to see. */
    return [];
  }
}

/**
 * Full names and usable first names, lowercase, longest first.
 *
 * Ordering matters at the point of use: a shorter name replaced first leaves
 * the rest of a full name stranded beside the placeholder.
 */
export function buildNameList(displayNames: readonly string[]): string[] {
  const out = new Set<string>();
  for (const raw of displayNames) {
    /* Directories carry "Smith, John" and "John Smith (Contractor)" in the
       same column, so both are reduced to the words before anything else. */
    const name = raw.replace(/\(.*?\)/g, " ").replace(/,/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
    if (!name) continue;
    const parts = name.split(" ").filter((p) => /^[a-z][a-z'’.-]*$/.test(p));
    if (parts.length === 0) continue;
    if (parts.length > 1) out.add(parts.join(" "));
    for (const p of parts) if (p.length >= MIN_FIRST_NAME) out.add(p);
  }
  return [...out].sort((a, b) => b.length - a.length);
}
