# Forcefield for WordPress

A one-install plugin that protects a WordPress site from hostile AI agents and bots.
No code: install, click Connect, click the emailed link. Watch-first and fail-open, so it never
takes the site down.

## Install (non-technical)

1. Download the plugin from the Forcefield signup page (or
   `npm run forcefield:wp-plugin-zip`) and upload it via Plugins -> Add New ->
   Upload. Activate **OGIAM Forcefield**.
2. Go to **Settings -> Forcefield** and click **Connect**. The plugin proves it
   runs on the site (Forcefield fetches a challenge from it); no key to copy.
3. Click the sign-in link Forcefield emails you. The plugin collects its own key
   and starts watching; the same link signs you in to the dashboard.
4. When you are ready, tick **Blocking** under Settings and Save to turn away
   proven-hostile requests. A key can still be pasted by hand under Settings.

## What it does

On each front-end request it forwards the request SHAPE (path, method, header
NAMES, user-agent, country) to the central engine with your key, and applies the
verdict. It sends **no** request bodies, header values, or PII. Detection lives
centrally, so new signatures go live without updating the plugin.

- **Dark until configured** - no key set, no-op.
- **Watch-first** - only blocks when you tick Blocking.
- **Fail-open** - any error serves the request.

## Scope + verification (honest)

v0.2 runs on `init` (priority 0), right after WordPress resolves the signed-in user, so it
guards pages, `wp-login.php`, `xmlrpc.php`, `admin-ajax.php`, the REST API (`/wp-json/` and
`?rest_route=`) and `wp-admin`. A signed-in user is reported but never blocked. WP-CLI, cron
and an administrator saving settings are skipped. `/wp-admin/install.php` and
`setup-config.php` load before any plugin, so no plugin can see them; put the Cloudflare
connector in front for those. The plugin's PHP is syntax-checked in
CI (`.github/workflows/php-lint.yml`, `php -l`), and its safety invariants are pinned
by a structural test (`cloudflare`-style parity, in the apex test suite). End-to-end
behavior on a live WordPress install is validated in that environment, not in this
repo's CI, and publishing to the WordPress.org plugin directory is a separate step
that needs the WordPress.org account.
