/**
 * Client-safe constants shared by the public Forcefield onboarding pages
 * (/forcefield/signup, /forcefield/setup, /forcefield/dashboard). No server
 * imports, so it can load in a "use client" bundle.
 */

/** localStorage key for the one-time onboarding setup key (x-forcefield-setup). */
export const SETUP_KEY_STORAGE = "ff_setup_key";
/** localStorage key for the tenant ingest token the dashboard uses (x-forcefield-token). */
export const DASHBOARD_TOKEN_STORAGE = "ff_dashboard_token";

export function readStored(key: string): string {
  try { return window.localStorage.getItem(key) ?? ""; } catch { return ""; }
}
export function writeStored(key: string, value: string): void {
  try { window.localStorage.setItem(key, value); } catch { /* private mode: the page still works for this visit */ }
}
export function clearStored(key: string): void {
  try { window.localStorage.removeItem(key); } catch { /* ignore */ }
}
