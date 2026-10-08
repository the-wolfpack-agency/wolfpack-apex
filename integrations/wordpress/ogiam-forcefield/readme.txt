=== OGIAM Forcefield ===
Contributors: ogiam
Tags: security, bots, ai, firewall, bot-protection
Requires at least: 6.0
Tested up to: 6.7
Requires PHP: 7.4
Stable tag: 0.1.0
License: Proprietary

Protect your site from hostile AI agents and bots. Install, paste your site key, done. Watch-first and fail-open: it never takes your site down.

== Description ==

OGIAM Forcefield puts your site behind a central agent-and-bot defense engine. On
each front-end request it forwards the request SHAPE (path, method, header names,
user-agent, country) to the engine with your site key and applies the verdict. It
sends no request bodies, no header values, and no PII.

Detection lives centrally, so new scanner signatures and trap paths go live without
updating the plugin.

* Dark until configured: no key set, it does nothing.
* Watch-first: it only blocks once you turn Blocking on.
* Fail-open: any error serves the request. It can never take your site down.
* Never gates wp-admin.

== Installation ==

1. Upload the `ogiam-forcefield` folder to `/wp-content/plugins/`, or install the
   zip via Plugins -> Add New -> Upload.
2. Activate the plugin.
3. Go to Settings -> Forcefield, paste your Site label and Site key (from your OGIAM
   /admin/forcefield onboarding), and Save.
4. It now watches. When ready, tick Blocking and Save to turn away proven-hostile
   requests.

== Frequently Asked Questions ==

= Will this block real visitors? =

No. It is watch-first (off until you enable Blocking), and it only ever turns away
requests the engine has proven hostile (named scanners, injection payloads, decoy
trips). A normal visitor is never affected. If the engine is unreachable, the plugin
fails open and serves the request.

= What data leaves my site? =

Only the request SHAPE: path, HTTP method, the NAMES of request headers, the
user-agent, and the country. No request bodies, no header values, no PII.

= Does it cover the REST API and wp-admin? =

This version guards front-end page requests and never gates wp-admin. REST API
coverage is planned for a later version.

== Changelog ==

= 0.1.0 =
* Initial release: watch-first, fail-open front-end protection via the central engine.
