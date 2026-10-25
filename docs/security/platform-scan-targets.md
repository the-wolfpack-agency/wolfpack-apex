# Platform-scan targets: putting our own properties under the continuous sweeps

Two crons keep platform posture fresh (schedules in `vercel.json`):

| Cron | Schedule (UTC) | What it assesses | Registry it reads |
|---|---|---|---|
| `GET /api/cron/engagement-sweep` | `0 */12 * * *` | static scan, system profile and recommendations for every **profiled** platform | `listSystemProfiles("default")` |
| `GET /api/cron/pentest-sweep` | `30 */12 * * *` | authorized active probes for every platform with an **active pentest scope** | `listScopes("default")` |

Both sweeps run against the workspace `default`. A profile or a scope created
from any other workspace is never picked up by the cron.

## What every sweep run records

Every run is written to `instinct_sweep_runs` with one of these statuses
(`src/lib/platform-scan/sweep-health.ts`, migration 294):

| Status | Meaning | Event |
|---|---|---|
| `ok` | every target was assessed | `platform.sweep_completed` |
| `partial` | some targets were assessed, others failed or were skipped | `platform.sweep_failed` |
| `failed` | the sweep threw, or targets failed and none was assessed | `platform.sweep_failed` |
| `no_targets` | nothing was assessed: zero targets, or every target skipped | `platform.sweep_no_targets` |

A skipped target is never a success. Skip reasons include `no_static_target`
(engagement), `no_active_scope`, `unknown_platform` and `no_runnable_cases`
(pentest). The operator gets one notification when a sweep moves into a
`partial`, `failed` or `no_targets` state, not one per tick.

Until the steps below are done, both sweeps record `no_targets`. That status is
correct: nothing is being assessed.

## Our own properties need no DNS step

`wolfpack-instinct` and `ogiam` are curated entries in
`src/lib/platform-scan/manifests.ts`. Curated targets are exempt from the
client-ownership (DNS TXT) verification because we operate them
(`isCuratedTarget`). They now also carry a `static` repo target, so the
engagement sweep can profile and scan them:

| Platform | Base URL | Static repo target |
|---|---|---|
| `wolfpack-instinct` | `https://wolfpack-instinct.vercel.app` | `the-wolfpack-agency/wolfpack-apex@main` |
| `ogiam` | `https://ogiam.com` | `the-wolfpack-agency/OGIAM@main` |

The repo files are read with the existing `GITHUB_TOKEN_WOLFPACK_AGENCY` PAT
(`src/lib/platform-scan/static/scan.ts`, `discover-files.ts`). `OGIAM` is a
private repo, so that PAT must have read access to it. If it does not, the
engagement run for `ogiam` records an `error:` outcome and the sweep becomes
`partial` or `failed`, which is visible, not silent.

## Operator steps

All calls need a signed-in user with the `settings.manage_team` capability whose
workspace is `default`. `$TOKEN` below is a placeholder for that user's access
token (the `Authorization: Bearer` value the app sends; it expires after 15
minutes). Never paste a real token into a shared document.

```sh
BASE=https://wolfpack-instinct.vercel.app
TOKEN='<access-token-placeholder>'
```

### 1. Create the system profile for each property (engagement sweep)

The engagement sweep only sweeps platforms that have a saved system profile.
`POST /api/admin/platform-scans/profile` builds and saves one. Body: `{ "platform": string }`.

```sh
for p in wolfpack-instinct ogiam; do
  curl -sS -X POST "$BASE/api/admin/platform-scans/profile" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"platform\":\"$p\"}"
  echo
done
```

Expected: `200 {"ok":true,"platform":"...","profile":{...}}`. Errors:
`400 platform_required`, `404 unknown_platform`, `400 no_static_target` (the
manifest has no repo target; should not happen for these two after this change),
`401`/`403` (not signed in, or missing `settings.manage_team`).

Check: `GET $BASE/api/admin/platform-scans/profile?all=1` lists both profiles.

### 2. Issue a pentest authorization for each property (pentest sweep)

`POST /api/admin/pentest/authorizations` issues a rules-of-engagement scope. The
validator in `src/app/api/admin/pentest/authorizations/route.ts` requires:

| Field | Type | Rule |
|---|---|---|
| `platform` | string | non-empty |
| `allowedHosts` | string[] | at least one; the probe's target hostname must be in it |
| `allowedTechniques` | string[] | at least one of `idor`, `auth_bypass`, `rate_limit`, `info_disclosure`, `injection` |
| `maxRequests` | integer | 1 to 10000 |
| `ttlMinutes` | integer | 1 to 43200 (30 days) |

The sweep runs only the `info_disclosure` technique
(`src/lib/platform-scan/pentest/engagement.ts`).

```sh
curl -sS -X POST "$BASE/api/admin/pentest/authorizations" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"platform":"wolfpack-instinct","allowedHosts":["wolfpack-instinct.vercel.app"],"allowedTechniques":["info_disclosure"],"maxRequests":500,"ttlMinutes":43200}'

curl -sS -X POST "$BASE/api/admin/pentest/authorizations" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"platform":"ogiam","allowedHosts":["ogiam.com"],"allowedTechniques":["info_disclosure"],"maxRequests":500,"ttlMinutes":43200}'
```

Expected: `201 {"ok":true,"scope":{...}}`. Errors: `400 platform_invalid`,
`allowedHosts_invalid`, `allowedTechniques_invalid`, `maxRequests_invalid`,
`ttlMinutes_invalid`; `401`/`403` as above. A scope expires after `ttlMinutes`
and must be reissued; once it lapses the pentest sweep records `no_active_scope`.

Kill switch: `DELETE $BASE/api/admin/pentest/authorizations?id=<scope id>` or
`?all=1`.

**Known limit (operator decision).** `info_disclosure` probes only manifest
routes marked `auth: "required"`. Neither manifest has one today:
`wolfpack-instinct` gates its dashboard in the browser (the shell returns 200 to
an unauthenticated GET, so an `auth: "required"` route would be a false finding),
and `ogiam` is seeded with the home route only. With a scope issued, each
property therefore records `no_runnable_cases`, and the pentest sweep reports
`no_targets` rather than a false `ok`. Making the pentest sweep assess them needs
server-gated routes added to their manifests. That choice is not made in this
change.

### 3. Verify

Trigger each sweep once by hand (same auth) instead of waiting for the cron:

```sh
curl -sS "$BASE/api/cron/engagement-sweep" -H "Authorization: Bearer $TOKEN"
curl -sS "$BASE/api/cron/pentest-sweep"    -H "Authorization: Bearer $TOKEN"
```

Read `health.status` and `health.targetsSucceeded` / `targetsSkipped` /
`targetsFailed` in each response. The engagement sweep should report `ok` with
two targets assessed.

## Client sites: written authorization required

The curated exemption from ownership verification also covers two **client**
sites in `SCAN_MANIFESTS`: `porsche-weekend` (`https://weekendwithporsche.com`)
and `aidan-mulready` (`https://aidanmulready.com`). Being curated means the code
does not ask them to prove ownership. It does not mean we are authorized to scan
or pentest them. Issuing a profile or a pentest scope for either one needs the
client's written authorization first. That is the operator's decision. This
change does not add repo targets for them and does not change their exemption.
