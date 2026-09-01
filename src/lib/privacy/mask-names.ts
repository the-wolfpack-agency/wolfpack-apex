/**
 * Take the people out of text that is about to be shown to somebody.
 *
 * WHY IT IS SHARED. Two surfaces needed exactly this and only one had it. The
 * gap panel on /pilot masked colleagues out of logged questions; the calendar
 * calibration question rendered raw entry titles, and on our own data that put
 * a colleague's name and their time off in front of a client. Same problem,
 * same corpus of names, and a second copy would have drifted from the first.
 *
 * IT IS NOT A PII DETECTOR AND DOES NOT PRETEND TO BE. It masks names the
 * workspace already knows about, from its own directory. Anyone outside that,
 * a customer, a supplier, a misspelling, goes through untouched. That is a real
 * limit rather than a rounding error, so callers should treat masking as the
 * last line of a defense whose first line is not showing free text at all.
 */

/**
 * Replace every known name with what the person is to the reader.
 *
 * Longest first, so a full name is matched before its first name and never
 * left as a surname sitting beside a placeholder. buildNameList already
 * returns them in that order.
 */
export function maskKnownNames(
  text: string,
  known: readonly string[],
  replacement = "a colleague",
): { text: string; masked: boolean } {
  let out = text;
  let masked = false;
  for (const name of known) {
    /* Escaped because a directory holds names with dots and hyphens in them,
       and an unescaped one silently becomes a wildcard that masks real words. */
    const safe = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(?<![a-z])${safe}(?![a-z])`, "gi");
    if (re.test(out)) {
      masked = true;
      out = out.replace(re, replacement);
    }
  }
  return { text: out, masked };
}
