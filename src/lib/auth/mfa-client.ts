/**
 * mfa-client.ts - browser-safe helpers for the admin MFA redirect. No node
 * imports, so both the dashboard layout and the /mfa page can use it.
 */

export type MfaRequired = null | "enroll" | "challenge" | "unavailable";

export const MFA_PAGE = "/mfa";

/**
 * A same-origin path to return to after MFA, or "/" when the value is unsafe.
 * Refuses absolute URLs, protocol-relative "//host", backslash tricks, and the
 * MFA page itself (which would loop).
 */
export function safeNextPath(raw: string | null | undefined): string {
  if (!raw || typeof raw !== "string") return "/";
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) return "/";
  if (raw === MFA_PAGE || raw.startsWith(`${MFA_PAGE}?`) || raw.startsWith(`${MFA_PAGE}/`)) return "/";
  return raw;
}

/** Where the dashboard layout should send this user, or null to stay. */
export function mfaRedirectFor(required: MfaRequired | undefined, currentPath: string | null | undefined): string | null {
  if (required !== "enroll" && required !== "challenge") return null;
  const next = safeNextPath(currentPath);
  return next === "/" ? MFA_PAGE : `${MFA_PAGE}?next=${encodeURIComponent(next)}`;
}

/** Full-page navigation (a seam so tests can observe it; jsdom cannot). */
export function navigateTo(href: string): void {
  window.location.href = href;
}
