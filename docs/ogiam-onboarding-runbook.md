# OGIAM Client Onboarding Runbook (single source of truth)

Status: living operational runbook. This is the canonical, end-to-end procedure
for taking a brand-new client from "nothing configured" to "full baseline
engagement delivered, posture tracked continuously." Every step lists the exact
UI path, the API it calls, what to expect, and how to verify it worked before
moving on. Follow it top to bottom for a first onboarding; jump to a section for
a repeat task.

Audience: the operator running a deployment. Internal. Public product name is
**Wolfpack Instinct / OGIAM**; never use the old code name in client-facing copy.

> Screenshots: each step has a `[[screenshot: ...]]` placeholder. Capture these
> on the FIRST real onboarding and drop them inline. Until then the written flow
> below is the source of truth. Do not skip a step because a screenshot is
> missing.

---

## 0. Mental model (read once)

One governed agent runs the whole arc against a client system:

```
connect -> onboard -> PREFLIGHT -> baseline (map + scan + recommend + report)
        -> [authorized] active pen test -> remediate (review-gated PRs)
        -> deliver report -> continuous (cron sweeps)
```

Two hard rules that the platform enforces technically, not by convention:

1. **Read-only first, always.** Scanning, mapping, and reporting never mutate a
   client system. Active pen testing does nothing until an admin issues a scope
   token (the signed rules of engagement), and a kill switch stops any run.
2. **Every action is recorded.** Each step writes an analytics event and a
   tamper-evident audit entry, and durable findings triple-write (Postgres +
   Qdrant + Neo4j). Nothing the agent does is off the books. This is the
   defensible per-client record.

---

## 1. Prerequisites: manual configuration (one-time per deployment)

These are set in Vercel (or the host) before anything works. A missing value is
a crash-loop, so confirm them first. Full list and purpose: `.ai/client-context.md`.

Deployment blockers (must be set):

| Env var | Why it matters for onboarding |
|---|---|
| `DATABASE_URL` | Source of truth. Targets, findings, audit chain all live here. |
| `INSTINCT_JWT_SECRET` | Auth. App throws without it (>=32 chars). |
| `GITHUB_TOKEN_WOLFPACK_AGENCY` | Static (source) scanning AND remediation PRs. Scope it to only the client repos in play. |
| `QDRANT_URL` / `QDRANT_API_KEY` | Triple-write vector store (findings feed the learning loop). |
| `NEO4J_URI` / `NEO4J_USER` / `NEO4J_PASSWORD` | Triple-write graph store (relationship context). |
| `CRON_SECRET` | Authorizes the continuous sweep crons (Section 9). |

Pen-test-specific:

| Env var | Why |
|---|---|
| `PENTEST_KILL_SWITCH` | Set to a truthy value to globally disable ALL active probing instantly, regardless of scope tokens. Leave unset in normal operation; flip it the moment anything looks wrong. |

Operator access: you need an account whose role grants `settings.manage_team`
(every admin route in this runbook gates on that capability). Confirm you can
load `/admin/onboarding` without a 403 before continuing.

`[[screenshot: Vercel env vars set, /admin/onboarding loads]]`

Verify: log in, open `/admin/onboarding`. If it renders (not a 401 redirect, not
a 403), prerequisites are good.

---

## 2. Connect the client's third-party system (example: Salesforce)

This is how the agent gets authenticated visibility into a SaaS platform the
client already uses. Done once per connected system.

UI: `/admin/connectors`. API: `/api/admin/connectors` (+ the OAuth subroutes).

Two connection shapes are supported; pick by what the platform offers:

- **OAuth (recommended where available).** Start the flow:
  `/api/admin/connectors/oauth/<provider>/start` redirects to the platform's
  consent screen; the platform calls back to
  `/api/admin/connectors/oauth/<provider>/callback`, which stores the connection.
  Use this for Microsoft 365 and any provider with a registered OAuth app.
- **OAuth password / token exchange (Salesforce).** Salesforce uses an OAuth
  username-password token exchange against `/services/oauth2/token`. Provide the
  connected-app `clientId` + `clientSecret` and the integration user's
  `username` + `password`. The agent exchanges them for a bearer token and
  scans the per-org `instance_url` the token is scoped to (not the login host).
  Credentials are stored server-side and are never logged.

Principle of least privilege: the client should provision a dedicated
integration user / connected app scoped to the minimum the engagement needs.
Document what you asked for; it goes in the rules of engagement later.

`[[screenshot: /admin/connectors with the Salesforce connection listed as connected]]`

Verify: hit `/api/admin/connectors/<name>/verify`. It should report the
connection as healthy. If it fails, the credentials or scopes are wrong; fix
before onboarding. Disconnect any time via `/api/admin/connectors/<name>/disconnect`.

---

## 3. Onboard the target into the registry

This registers WHAT to assess (the base URL, optionally a source repo, optionally
a login) so a client can be onboarded without a code change. Done once per system.

UI: `/admin/onboarding`. API: `POST /api/admin/platform-scans/targets`.

Fields:

- `platform` (the id you will reference everywhere after this, e.g. `acme-crm`).
- `baseUrl` (public URL of the running system). Private-IP / internal literals
  are rejected at input validation; the SSRF floor will also block them at scan
  time. This is deliberate.
- `static` (optional): `{ owner, repo, ref, paths }` to enable source scanning
  via the GitHub token. Omit for black-box-only (HTTP) targets.
- `login` (optional): `{ connectorName, loginPath, sessionCookieName }` linking
  to the connector from Section 2 so scans run authenticated. `connectorName`
  must match the connector you connected.

How target resolution works (so you know what you are configuring): the platform
resolves a target in this order at scan time: curated manifest -> this stored
target -> connector. The stored registry is the normal client path.

`[[screenshot: /admin/onboarding target created, listed in the Targets table]]`

Verify: the new target appears in the Targets table on `/admin/onboarding`.
List via `GET /api/admin/platform-scans/targets`.

---

## 4. Preflight: verify the target BEFORE running anything

This is the readiness gate. It catches a misconfiguration here, on your screen,
instead of in front of the client during the engagement. All checks are
read-only and non-destructive.

UI: the **Test connection** button on each target row in `/admin/onboarding`.
API: `GET /api/admin/platform-scans/preflight?platform=<id>`.

It runs and reports each check pass/fail:

- `target_resolved`: the platform id resolves to a target. (critical)
- `base_url_public`: the URL is public, not an internal address. (critical)
- `base_url_reachable`: the target responds (HTTP < 500). (critical)
- `repo_accessible`: the source repo lists files (only if `static` is set). (advisory)
- `login_credentials`: connector credentials exist (only if `login` is set). (critical)

An overall **Ready** banner means all critical checks passed; **Not ready** lists
exactly what to fix. The run is itself audited and tracked
(`platform.preflight_run`), so onboarding friction feeds the learning loop.

`[[screenshot: Test connection result panel showing Ready with all checks green]]`

Verify: banner reads Ready. If Not ready, fix the named check (almost always a
wrong baseUrl, an unreachable host, a repo-token scope, or a missing connector)
and re-run. Do not proceed to the baseline until preflight is Ready.

---

## 5. Run the baseline engagement (read-only): map + scan + recommend + report

This is the core deliverable and the credibility artifact. All read-only. Zero
risk to the client system.

UI: `/admin/platform-scans`. Run each step for the target's `platform` id:

1. **Scan** (security + quality): `POST /api/admin/platform-scans { platform }`.
   Black-box plus, if configured, authenticated and source scanning. Findings
   persist (dedup upsert, auto-resolve of fixed items, critical-notify, Brain
   ingest). Returns finding + critical counts.
2. **System profile** (the map): `GET /api/admin/platform-scans/profile?platform=<id>`.
   Deterministic introspection: surface, entities, integrations, auth model, risk.
3. **Recommendations** (automation mapping):
   `GET /api/admin/platform-scans/recommendations?platform=<id>`. Deterministic
   rules to gate-governed automation proposals.
4. **Summary** (the report view):
   `GET /api/admin/platform-scans/summary?platform=<id>`. Open findings by
   severity and category, plus the posture read. This is what becomes the
   Security Engagement Report.

Findings, profile, and recommendations all render in the `/admin/platform-scans`
UI. The report = profile (the map) + findings by severity (the security read) +
recommendations (the automation read) + the posture grade.

`[[screenshot: /admin/platform-scans showing findings by severity, the system profile, and recommendations]]`

Verify: counts are non-zero OR an explicit clean result; the profile renders the
system map; recommendations list. A blank panel is a bug, not a clean system;
re-check the scan completed (the POST returned ok) and the platform id matches.

---

## 6. Active pen testing (authorized only): the fail-closed harness

Do NOT do this in the baseline. Active testing happens only after a signed rules
of engagement and an issued scope token. The harness is fail-closed: nothing
probes until a scope exists, and everything is budgeted, time-boxed, host-scoped,
technique-scoped, and killable.

UI: `/admin/pentest`. The operator console.

1. **Issue a scope token** (the rules of engagement, encoded):
   `POST /api/admin/pentest/authorizations` with the allowed host(s), the allowed
   techniques, a request budget, and a TTL. This is the technical form of the
   signed authorization. Issue it only after the client has signed.
2. **Run probes or a full engagement.** Individual read-only GET probes:
   IDOR (`/api/admin/pentest/idor`), auth bypass (`/auth-bypass`), missing rate
   limit (`/rate-limit`), information disclosure (`/info-disclosure`), injection
   (`/injection`). Or run the full suite as one orchestrated engagement:
   `POST /api/admin/pentest/engagement { platform }`, which returns cases run /
   confirmed / skipped and persists confirmed findings.
3. **Review confirmed findings** in the console (`/api/admin/pentest/findings`).
   Precision-first: a finding shown is one the harness actively confirmed.
4. **Kill switch.** The console exposes it; `PENTEST_KILL_SWITCH` is the global
   env-level stop. Either halts all active probing instantly.

`[[screenshot: /admin/pentest with an active scope token and the confirmed-findings panel]]`

Verify: a scope token is listed as active with its budget and TTL; the engagement
returns confirmed counts; revoking the scope (or the kill switch) immediately
blocks further probes (try one and confirm it is refused).

---

## 7. Remediation: fixes as review-gated pull requests

The differentiator: a confirmed finding or a recommendation becomes a reviewable
fix, never an auto-merge.

From a recommendation, open a remediation PR (gate-governed): the platform creates
a branch and opens a pull request via the GitHub client and records
`platform.remediation_pr_opened` with the gate outcome and the PR URL. It NEVER
merges. A human reviews and merges. On the next scan, a merged fix auto-resolves
the finding (the find-fix-verify loop, closed).

`[[screenshot: an opened remediation PR linked from the recommendation]]`

Verify: the PR exists in the client repo, is open (not merged), and the
recommendation shows the PR URL. The GitHub token must have PR scope on that repo.

---

## 8. Deliver the report

The Security Engagement Report is assembled from Section 5 (map + findings +
recommendations + posture) plus, where authorized, the confirmed active findings
from Section 6. Deliver it as the client artifact: what was assessed, the system
map, findings by severity with remediation, recommended automations, the posture
grade, and (if run) the confirmed pen-test results with the fixes opened as PRs.

`[[screenshot: the assembled Security Engagement Report]]`

Verify: every claimed finding traces to a stored finding id; every fix traces to
a PR; the audit trail covers the engagement end to end (a defensible record).

---

## 9. Continuous: keep the posture live

Onboarding is not a one-shot. The cron sweeps keep every onboarded target current.

- Engagement sweep: `/api/cron/engagement-sweep` re-runs the read-only baseline
  across onboarded targets on a schedule.
- Pentest sweep: `/api/cron/pentest-sweep` re-runs active testing ONLY for
  targets with a currently valid scope token (expired scope = no active probing).

Both authorize with `CRON_SECRET`. Findings auto-resolve when fixed and re-open
if they regress, so the posture the client sees is always current, not a stale
snapshot.

Verify: after the first sweep, check that finding timestamps advanced and any
fixed items moved to resolved.

---

## 10. Onboarding checklist (copy per client)

```
[ ] Env vars set + operator has settings.manage_team        (Section 1)
[ ] Third-party system connected + verify passes            (Section 2)
[ ] Target onboarded in the registry                        (Section 3)
[ ] Preflight = Ready (all critical checks green)           (Section 4)
[ ] Baseline run: scan + profile + recommendations + report (Section 5)
[ ] Report delivered + audit trail confirmed                (Section 8)
--- only after signed rules of engagement ---
[ ] Scope token issued (host + techniques + budget + TTL)   (Section 6)
[ ] Active engagement run + confirmed findings reviewed     (Section 6)
[ ] Remediation PRs opened (review-gated, not merged)       (Section 7)
[ ] Continuous sweeps confirmed running                     (Section 9)
```

---

## Related

- [ogiam-client-deployment-plan.md](./ogiam-client-deployment-plan.md): the
  risk-sequenced go-to-market this runbook executes per client.
- [ogiam-pricing-and-packaging.md](./ogiam-pricing-and-packaging.md): how the
  steps above map to the offering tiers.
- `.ai/client-context.md`: full env var list and deployment blockers.
