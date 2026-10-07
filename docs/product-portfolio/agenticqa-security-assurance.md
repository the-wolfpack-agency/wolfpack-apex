# AgenticQA: Security Assurance (DRAFT, internal, strategy)

## What it is
Continuous security scanning plus a self-run penetration test, as a managed,
governed agent: map a target, scan it, actively probe it (read-only, scoped,
killable), and open remediation as review-gated pull requests. Fixes, not just
findings. Already a named product in `src/lib/products.ts` (AgenticQA).

## Who buys it
SaaS and agencies that need PTaaS + continuous scanning but cannot afford a
boutique pen test every quarter; teams that want findings turned into fixes.

## What we ALREADY have
- `src/lib/platform-scan/` - the scan engine + curated target manifests +
  black-box HTTP crawl + gray-box API contract probe.
- `src/lib/platform-scan/pentest/` - the ACTIVE engagement: `auth-bypass`, `idor`,
  `injection`, `info-disclosure`, `rate-limit`, a scope/guard harness (fail-closed,
  budgeted, killable) and `engagement.ts`.
- `scripts/forcefield-selftest.ts` (`npm run forcefield:selftest`) - the fast,
  always-safe boundary self-test, proven against prod.
- The AgenticQA static scanner (`wolfpack-auto/src/lib/security-hardening-scanner.ts`)
  + the CodeQL gate + the security-self-scan / security-hygiene / security-governance
  CI workflows.
- Remediation-as-PR via the Secure Agent (see its one-pager).

## Product surface to add
- Client onboarding: connect a target (the connector model in platform-scan
  already supports username/password + oauth), verify ownership, schedule scans.
- A findings dashboard + the PR-remediation loop surfaced for the client.
- Report export (the compliance evidence export pattern applies).

## Honest gap to market
The engine is the deepest-built here. The gaps are multi-tenant client onboarding
+ the ownership-verification gate at scale, and the non-fakeable third-party
attestation when a client wants a signed pen test. Pricing already drafted
(`docs/ogiam-pentest-pricing.md`, `docs/ogiam-pricing-and-packaging.md`). ~75%.

## Positioning + pricing hook
"PTaaS + continuous scanning + fixes, in days not weeks, with an auditable record."
Land with a free read-only scan (the wedge), expand to a continuous subscription.
