# Security Policy

## Reporting a vulnerability

Email **homyk@thewolfpack.agency** with:

- The affected URL or endpoint
- A minimal reproduction (curl / screenshot / steps)
- The impact you believe it has

We acknowledge within **48 hours** and update the reporter weekly until close.

## Scope

In scope:

- The deployed application: <https://wolfpack-instinct.vercel.app>
- This repository: <https://github.com/the-wolfpack-agency/wolfpack-apex>
- Public APIs under `/api/*` (excluding `/api/public/forms/*` which are
  intentionally anonymous form-submission endpoints)

Out of scope:

- Anything in `tests/`, `e2e/`, `__mocks__/`, `__tests__/`, or `.next/` —
  these are intentional test fixtures or compiled bundles.
- Social engineering / phishing of staff.
- Physical attacks on Wolfpack Agency infrastructure.
- Reports that require already-compromised end-user devices.

## Codified defenses

The following protections run automatically on every push and on a
schedule — researchers should assume these are active when assessing
impact:

- **Static code scanning** (every push): 36+ CWE classes via the
  AgenticQA scanner — see <https://github.com/nhomyk/AgenticQA>
- **Dependency audit**: `npm audit` gate fails CI on any high/critical
  CVE (`security-self-scan.yml`)
- **Pentest probes** (every push): IDOR, auth bypass, JWT, rate-limit,
  error-disclosure
- **Hourly health monitor**: `automations-health-monitor.yml`
- **Nightly DAST**: probes prod for missing security headers + error-
  page disclosure (`nightly-dast.yml`)
- **Weekly governance audit**: branch-protection + secret-age checks
  (`security-governance.yml`)
- **Content Security Policy** (enforced, not report-only): see
  `src/middleware.ts`
- **HSTS**: injected at the Vercel edge on production domains
- **Sensitive env vars**: marked Sensitive in Vercel — not readable
  via `vercel env pull` after creation
- **Dependabot**: daily npm + weekly github-actions, auto-merge on
  green patch/minor (`dependabot-auto-merge.yml`)

## Disclosure timeline

- **Day 0**: report received, acknowledged within 48 hours
- **Days 1–7**: triage, severity assessment, regression test scoped
- **Days 7–30**: fix shipped + deployed
- **Day 90 max**: public disclosure (coordinated with reporter)

## Hall of fame

Wolfpack Agency does not currently run a paid bounty program for
wolfpack-apex. Researchers who report responsibly are credited here
unless they request anonymity.
