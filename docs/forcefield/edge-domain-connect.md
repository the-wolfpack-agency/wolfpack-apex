# Forcefield Edge: one-click DNS with Domain Connect

## What Domain Connect is

Domain Connect (domainconnect.org, spec at github.com/Domain-Connect/spec) is an
open standard that lets a service provider (us) ask the customer's DNS provider
to apply a pre-approved set of records, with the customer approving it in their
DNS provider's own UI. No DNS credentials change hands.

1. Discovery. We look up the TXT record `_domainconnect.<domain>`. It names the
   DNS provider's Domain Connect host. `GET https://<that host>/v2/<domain>/settings`
   returns `providerId`, `urlSyncUX`, `urlAsyncUX`, `urlAPI`. A 404 means the
   provider does not host the zone (fall back to the manual record).
2. Apply (synchronous flow). We send the customer's browser to
   `{urlSyncUX}/v2/domainTemplates/providers/{providerId}/services/{serviceId}/apply?domain=<zone>&host=<label>&redirect_uri=...&state=...`,
   signed: `sig` is a SHA-256 signature over the query string and `key` names
   the TXT host (under `syncPubKeyDomain`) that publishes our public key. The
   customer logs in to their DNS provider, sees exactly which record will be
   added, and approves. The provider redirects back to `redirect_uri`, which must
   be inside `syncRedirectDomain`.
3. The template. The records applied are fixed by a template we publish, not by
   the URL. Variables are allowed but the spec advises keeping them minimal;
   providers scrutinize templates whose targets are variable.

## Verified for ogiam.com today

- `_domainconnect.ogiam.com` is `_domainconnect.gd.domaincontrol.com`.
- `https://domainconnect.api.godaddy.com/v2/ogiam.com/settings` answers
  `providerId: godaddy.com`, `urlSyncUX: https://dcc.godaddy.com/manage`.

So GoDaddy-hosted zones (a large share of small-business sites) already support
the flow. The public template repository (github.com/Domain-Connect/Templates)
holds about a thousand templates, including subdomain templates of the same
shape as ours.

## Our template

`edge/domain-connect/ogiam.com.forcefield-edge.json`:

- `providerId: ogiam.com`, `serviceId: forcefield-edge`, file named
  `{providerId}.{serviceId}.json` as the repository requires.
- ONE record: a CNAME at the chosen host (`host: "@"` with `hostRequired: true`,
  the subdomain pattern: the record lands on the `host` the apply URL names, for
  example `www`), pointing at a FIXED target, `cname.vercel-dns.com`, the
  platform's documented generic target. A fixed target is what providers accept
  most readily; the per-project target the platform recommends today (a
  `*.vercel-dns-0NN.com` name) would need a `%variable%` in `pointsTo`, which
  some providers reject by policy. If the generic target ever stops being
  accepted, version 2 of the template moves to a variable.
- `syncPubKeyDomain: ogiam.com` (signed requests, which the repository requires
  of every template that is not async-only) and `syncRedirectDomain:
  wolfpack-instinct.vercel.app` (the console the customer returns to).
- Apex domains are not covered: a CNAME cannot sit at a zone apex. An apex
  hostname keeps the manual A record the admin action reports.

## What it takes to turn on (operator actions, not done)

1. Generate a signing key pair; publish the public key as TXT records at
   `_dcpubkeyv1.ogiam.com` (the spec's key host format; long keys split across
   records with `p=1,a=RS256,d=...` segments). The private key goes in apex env.
2. Lint the template with the repository's `dc-template-linter` and test it in
   the repository's online editor.
3. Open a pull request to github.com/Domain-Connect/Templates with the editor
   test link, as the repository's PR template asks. Each DNS provider then
   onboards templates from the repository on its own schedule; GoDaddy is the
   first to confirm with.
4. Code that follows (not built): discovery + signed apply URL generation in the
   admin flow, falling back to the manual record when discovery 404s or the
   provider has not onboarded the template, and `check_hostname` after the
   customer returns.

No template has been submitted and nothing has been registered with any
registrar or DNS provider.
