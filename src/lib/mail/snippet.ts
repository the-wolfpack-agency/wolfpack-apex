/**
 * cleanMailSnippet — strip MS Graph bodyPreview noise so the UI shows
 * the actual message instead of Teams invite boilerplate, quoted-reply
 * headers, mobile-client footers, and long separator lines.
 *
 * Conservative by design: only well-known patterns are stripped, and if
 * scrubbing would leave an empty string we fall back to the trimmed
 * original so a bad heuristic can never blank a cell.
 */

const CUT_POINTS: RegExp[] = [
  /_{4,}/,
  /-{10,}/,
  /\bMicrosoft Teams meeting\b/i,
  /\bJoin Microsoft Teams Meeting\b/i,
  /\bGet Outlook for (iOS|Android)\b/i,
  /\bSent from my (iPhone|iPad|Android|BlackBerry|mobile device)\b/i,
  /From:\s+\S.{0,160}?Sent:\s/i,
  /\bOn .{5,80}?\bwrote:\s*/i,
];

export function cleanMailSnippet(
  raw: string | null | undefined,
  maxLen = 220,
): string {
  if (!raw) return "";

  let cut = raw.length;
  for (const re of CUT_POINTS) {
    const m = re.exec(raw);
    if (m && m.index < cut) cut = m.index;
  }

  const cleaned = raw.slice(0, cut).replace(/\s+/g, " ").trim();

  const out = cleaned || raw.replace(/\s+/g, " ").trim();
  return out.length > maxLen ? out.slice(0, maxLen - 1).trimEnd() + "…" : out;
}
