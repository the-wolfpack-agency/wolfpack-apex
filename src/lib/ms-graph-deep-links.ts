/**
 * Microsoft Teams deep-link builders (Phase 1).
 *
 * Pure string helpers — no Graph calls, no I/O, no analytics (the
 * route layer fires `ms_deep_link.generated`). Because these bypass
 * the Graph API, they cost zero additional scope; they let us ship
 * send-chat / call / meet-now capabilities in Phase 1 without
 * requesting `Chat.ReadWrite` or `Calls.Initiate`.
 *
 * Format references:
 * - Chat:     https://teams.microsoft.com/l/chat/0/0?users=<email>[&message=<urlenc>]
 * - Call:     https://teams.microsoft.com/l/call/0/0?users=<email>&withVideo=0|1
 * - Meet now: https://teams.microsoft.com/l/meeting/new
 */

const TEAMS_BASE = "https://teams.microsoft.com";

function normalizeEmail(input: string): string {
  if (typeof input !== "string") {
    throw new TypeError("recipientEmail must be a string");
  }
  const trimmed = input.trim();
  if (!trimmed.includes("@")) {
    throw new TypeError("recipientEmail must look like an email address");
  }
  return trimmed;
}

/**
 * Build a 1:1 Teams chat deep-link. If `message` is provided it is
 * URL-encoded and prefilled in the compose box; the recipient still
 * sends manually.
 */
export function chatDeepLink(recipientEmail: string, message?: string): string {
  const email = normalizeEmail(recipientEmail);
  const usersParam = encodeURIComponent(email);
  let url = `${TEAMS_BASE}/l/chat/0/0?users=${usersParam}`;
  if (typeof message === "string" && message.length > 0) {
    url += `&message=${encodeURIComponent(message)}`;
  }
  return url;
}

/**
 * Build a Teams call deep-link. `withVideo` toggles the video=1 flag
 * (defaults to audio-only).
 */
export function callDeepLink(recipientEmail: string, withVideo: boolean = false): string {
  const email = normalizeEmail(recipientEmail);
  const usersParam = encodeURIComponent(email);
  return `${TEAMS_BASE}/l/call/0/0?users=${usersParam}&withVideo=${withVideo ? 1 : 0}`;
}

/**
 * Build a Teams "meet now" deep-link. Opens a fresh ad-hoc meeting.
 */
export function meetNowDeepLink(): string {
  return `${TEAMS_BASE}/l/meeting/new`;
}
