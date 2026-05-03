/**
 * src/lib/log-sanitize — defense-in-depth helper for log lines.
 *
 * User-controlled strings flowing into console.* (or any log appender)
 * can forge log entries by smuggling CR/LF into the payload — once a
 * newline lands in the log, an attacker can fake a second log line
 * ("[admin] login OK") and confuse incident triage. Strip control bytes
 * + tabs + newlines, then cap length so a megabyte payload can't blow
 * up Vercel log bandwidth.
 *
 * Usage:
 *   console.error("[route] failed:", sanitizeForLog(err.message));
 *
 * Cap defaults to 200 chars — the route layer never needs more than
 * that for an error-line, and capping is what keeps a malicious payload
 * from drowning the log file.
 */
export function sanitizeForLog(value: unknown, maxLen = 200): string {
  if (value === null || value === undefined) return "";
  const s = typeof value === "string" ? value : String(value);
  /* Strip CR/LF/TAB and all C0 control chars (0x00-0x1f) plus DEL. */
  // eslint-disable-next-line no-control-regex
  const stripped = s.replace(/[\x00-\x1f\x7f]/g, "");
  return stripped.length > maxLen ? stripped.slice(0, maxLen) : stripped;
}
