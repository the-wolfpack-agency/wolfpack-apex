=== OGIAM Forcefield ===
Contributors: ogiam
Tags: security, bots, ai, firewall, bot-protection
Requires at least: 6.0
Tested up to: 7.1
Requires PHP: 7.4
Stable tag: 0.3.0
License: Proprietary

Protect your site from hostile AI agents and bots. Click Connect, click the emailed link, done. Watch-first and fail-open.

== Description ==

OGIAM Forcefield puts your site behind a central agent-and-bot defense engine. On
each request WordPress handles it forwards the request SHAPE (path, method, header
names, user-agent, accept, sec-fetch-dest, country, client IP) to the engine with
your site key and applies the verdict. It sends no request bodies, no cookies, and
no other header values. The client IP is used only to classify the network (for
example a hosting provider) and is then discarded, never stored.

It covers the paths attackers hit hardest on WordPress: wp-login.php, xmlrpc.php,
admin-ajax.php, the REST API (wp-json) and wp-admin, as well as normal pages. The
engine knows these are your site's own WordPress paths, so a visit to them alone is
never treated as an attack; only proven-hostile requests (named scanners, injection
payloads, decoy trips) are turned away.

Detection lives centrally, so new scanner signatures and trap paths go live without
updating the plugin.

* Dark until configured: no key set, it does nothing.
* Watch-first: it only blocks once you turn Blocking on.
* Never blocks a signed-in user: requests from a signed-in WordPress session are
  reported but always served, in every mode.
* Fail-open: any error, timeout or unexpected answer serves the request. It can
  never take your site down.
* Stays out of the way of WP-CLI, cron runs and saving its own settings.

== Installation ==

1. Install the plugin from Plugins -> Add New (search for OGIAM Forcefield), or
   upload the zip via Plugins -> Add New -> Upload, and activate it.
2. Go to Settings -> Forcefield, check the email address and click Connect.
   Forcefield checks that the plugin is running on your site; there is no key to
   copy, no DNS record and no file to upload.
3. Click the sign-in link Forcefield emails you. The plugin connects itself
   within a minute and starts watching. The same link signs you in to your live
   Forcefield dashboard.
4. When ready, tick Blocking under Settings and Save to turn away proven-hostile
   requests.

You can still paste a site key by hand under Settings if you were given one.

== External services ==

This plugin connects your site to the OGIAM Forcefield engine
(https://wolfpack-instinct.vercel.app, operated by The Wolfpack Agency), which
decides whether a request is a hostile automated action.

* When you click Connect, it sends your site address, the email you entered and
  your site name, plus a random secret the plugin generated, so Forcefield can
  check ownership and email you a sign-in link. Forcefield then requests one
  address on your site (/?rest_route=/ogiam-forcefield/v1/challenge) to confirm
  the plugin is running there.
* Once connected, on each request it sends the request shape described above
  (path, method, header names, user-agent, accept, sec-fetch-dest, country,
  whether the visitor is signed in, and the client IP, which is classified and
  then discarded). No request bodies, cookies or account details are sent.

Nothing is sent until you click Connect or enter a site key.

== Frequently Asked Questions ==

= Do I need to copy a key or change DNS? =

No. Click Connect: Forcefield verifies the site by asking the plugin itself
(a check only code running on your site can answer), then emails you a sign-in
link. When you click it, the plugin collects its own key. The DNS record and
file methods are only for sites without this plugin.

= Will this block real visitors? =

No. It is watch-first (off until you enable Blocking), and it only ever turns away
requests the engine has proven hostile (named scanners, injection payloads, decoy
trips). A normal visitor is never affected. If the engine is unreachable, the plugin
fails open and serves the request.

= What data leaves my site? =

Only the request SHAPE: path and query, HTTP method, the NAMES of request
headers, the user-agent, the accept and sec-fetch-dest headers, the country,
whether the visitor is signed in (yes or no, never who), and the client IP, which
the engine classifies and then discards. No request bodies, no cookies, no other
header values, no account details.

= Does it cover the REST API and wp-admin? =

Yes, from version 0.2.0. It runs on the WordPress `init` hook, so it sees
wp-login.php, xmlrpc.php, admin-ajax.php, the REST API and wp-admin, not only
front-end pages. A blocked REST or admin-ajax call gets a JSON 403, a blocked
XML-RPC call gets an XML-RPC fault with a 403, and a blocked page gets a plain
403 page. No internal detail is shown.

Two installer screens, wp-admin/install.php and wp-admin/setup-config.php, run
before WordPress loads any plugin, so no plugin can see them. To cover those too,
use the OGIAM Forcefield Cloudflare connector in front of the site.

= Does it protect against PHP2Shell (the PHP request-parser RCE)? =

Not from WordPress. PHP2Shell (CVE-2026-109618 / CVE-2026-109619) triggers inside
PHP's own request parser before any plugin loads, so no WordPress plugin can stop
it - this one does not read request bodies and does not try. Patch PHP to a fixed
release (8.5.12 / 8.4.27 / 8.3.36 / 8.2.35 or your vendor's backport), and put the
OGIAM Forcefield Cloudflare connector in front of your site: it inspects a bounded
part of the request body at the edge, before PHP parses it, and turns the known
attack shapes away. The same Cloudflare-only inspection covers React2Shell
(CVE-2025-55182) for sites that serve React Server Components.

= Can it lock me out of my own site? =

No. A signed-in user is never blocked, in any mode. Saving the plugin's settings
is never checked, so a wrong key or engine URL can always be corrected. If the
engine is unreachable or slow, the request is served.

= My site is behind Cloudflare or a load balancer. Which client IP is used? =

By default the plugin uses the direct connection address (REMOTE_ADDR), which a
visitor cannot forge. If every request reaches your server through Cloudflare or a
reverse proxy, choose it under Client IP source. Do not choose a proxy if visitors
can reach your server directly: they could then send a fake IP header.

== Changelog ==

= 0.3.0 =
* One-click Connect: no key to copy. The plugin answers a server-issued
  ownership check from your site, Forcefield emails a sign-in link, and the
  plugin collects its own site key once you click it (checked on the settings
  page and once a minute through WP-Cron).
* The manual site key settings move under a Settings section on the same page.

= 0.2.0 =
* Coverage: the guard now runs on `init` (priority 0) instead of
  `template_redirect`, so wp-login.php, xmlrpc.php, admin-ajax.php, the REST API
  and wp-admin are protected, not only front-end pages.
* Signed-in users are never blocked in any mode, and are reported as
  authenticated so the engine does not treat them as bots.
* The engine is told the site runs WordPress, so WordPress's own paths are not
  reported as reconnaissance.
* Sends the client IP (REMOTE_ADDR by default; a proxy header only when you choose
  one), the accept and sec-fetch-dest headers and the full request URL.
* Context-aware 403: JSON for the REST API and admin-ajax, an XML-RPC fault for
  xmlrpc.php, a plain page elsewhere. No internal detail is shown.
* Skips WP-CLI, cron runs and saving the plugin's own settings.
* Fails open on a non-200 engine answer as well as on network errors.
* Settings are sanitized on save; the engine URL must be https.

= 0.1.0 =
* Initial release: watch-first, fail-open front-end protection via the central engine.
