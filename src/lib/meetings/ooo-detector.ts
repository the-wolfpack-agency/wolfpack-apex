/**
 * Out-of-office detector — pure, no I/O.
 *
 * Two signals:
 *   1. Microsoft Graph `showAs === "oof"` is the gospel marker. When set
 *      by the user (via Outlook's "Show As: Out of office") it is
 *      definitive.
 *   2. Subject-pattern matching catches the very common case where the
 *      user kept `showAs="busy"` (the default) but typed "OOO" / "OoO"
 *      / "Out of office" / "PTO" / "Vacation" / "On leave" / "Sick"
 *      in the meeting subject. Without this we miss roughly half of
 *      the OOO entries in practice.
 *
 * Anti-false-positive guard rails:
 *   - "WFH" / "Working from home" / "Remote" are NOT treated as OOO.
 *     People in those states are reachable.
 *   - "Holiday" alone is NOT treated as OOO. Company-wide holiday
 *     events would otherwise vanish from the dashboard.
 *   - Word-boundary regex prevents "POOL", "good", "phooey" etc.
 *     from matching "OOO".
 *
 * Used by:
 *   - src/lib/meetings/upcoming.ts to tag UpcomingMeeting.isOutOfOffice.
 *   - The API route splits the response so the dashboard dropdown
 *     shows real meetings only, with a passive "Out today: ..." line
 *     above for the OOO entries.
 */

/** Tokens that, when present as their own word, indicate the event is
 *  the person being out of office. Case-insensitive, word-boundary. */
const ACRONYMS = ["OOO", "OoO", "OOF", "OOTO", "PTO"];

/** Phrases that, when present as a substring (case-insensitive), indicate
 *  out of office. Looser match because phrases are not ambiguous. */
const PHRASES = [
  "out of office",
  "out of the office",
  "out of pocket",
  "on vacation",
  "on holiday vacation",
  "on leave",
  "out sick",
  "sick day",
  "sick leave",
  "personal day",
  "personal leave",
  "vacation day",
  "off today",
  "off tomorrow",
];

/** A simple "vacation" mention with no qualifier is OOO. Separated from
 *  PHRASES so we can keep PHRASES focused on multi-word patterns. */
const SINGLE_WORD_OOO = ["vacation", "vacationing"];

/** Word-boundary regex built once and cached. */
const ACRONYM_REGEX = new RegExp(
  `(?:^|[^A-Za-z])(${ACRONYMS.join("|")})(?:$|[^A-Za-z])`,
  "i",
);
const SINGLE_WORD_REGEX = new RegExp(
  `(?:^|[^A-Za-z])(${SINGLE_WORD_OOO.join("|")})(?:$|[^A-Za-z])`,
  "i",
);

export interface OooSignals {
  /** Microsoft Graph showAs value, if known. */
  showAs?: string | null;
  /** Event subject string. */
  subject?: string | null;
}

/**
 * Returns true when the event represents the user being out of office.
 *
 * Both signals are checked. Either is sufficient.
 */
export function isOutOfOffice(signals: OooSignals): boolean {
  if (signals.showAs === "oof") return true;
  return isOutOfOfficeSubject(signals.subject);
}

/**
 * Subject-only check. Exposed for tests and for callers that have only
 * the subject in hand (e.g. ICS imports without showAs).
 */
export function isOutOfOfficeSubject(subject: string | null | undefined): boolean {
  if (!subject || typeof subject !== "string") return false;
  const s = subject.toLowerCase();
  // Phrases first (lowest false-positive risk).
  for (const phrase of PHRASES) {
    if (s.includes(phrase)) return true;
  }
  // Single-word OOO (vacation alone).
  if (SINGLE_WORD_REGEX.test(subject)) return true;
  // Acronyms with word-boundary guard.
  if (ACRONYM_REGEX.test(subject)) return true;
  return false;
}
