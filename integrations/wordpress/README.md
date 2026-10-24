# Forcefield for WordPress

A one-install plugin that protects a WordPress site from hostile AI agents and bots.
No code: install, paste your site key, done. Watch-first and fail-open, so it never
takes the site down.

## Install (non-technical)

1. Copy the `ogiam-forcefield/` folder into `wp-content/plugins/` (or zip it and
   upload via Plugins -> Add New -> Upload).
2. Activate **OGIAM Forcefield**.
3. Go to **Settings -> Forcefield**, paste your **Site label** and **Site key**
   (from `/admin/forcefield` onboarding), and Save.
4. It now watches. When you are ready, tick **Blocking** and Save to turn away
   proven-hostile requests.

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
