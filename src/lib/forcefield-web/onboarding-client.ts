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

/** The install option the signup page shows (platform-detect.ts). */
export type SignupPlatform = "wordpress" | "vercel" | "other";

/** Flip to true once the plugin is live in the WordPress.org directory: the
 *  WordPress button then installs it from the site's own admin in one click. */
export const WORDPRESS_DIRECTORY_LISTED = false;
/** The plugin zip, built from the plugin source by the same writer as the
 *  directory zip (src/lib/forcefield-web/wordpress-plugin-zip.ts). */
export const WORDPRESS_PLUGIN_DOWNLOAD = "/api/forcefield/wordpress/plugin";

/** The site's own WordPress admin: the directory install once listed, the zip
 *  upload screen until then. */
export function wordpressInstallUrl(site: string): string {
  const host = String(site ?? "").trim().replace(/^https?:\/\//i, "").split(/[/?#]/)[0];
  return WORDPRESS_DIRECTORY_LISTED
    ? `https://${host}/wp-admin/plugin-install.php?tab=plugin-information&plugin=ogiam-forcefield`
    : `https://${host}/wp-admin/plugin-install.php?tab=upload`;
}
