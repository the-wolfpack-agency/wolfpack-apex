# Wolfpack Instinct — Release Report 2026-05-21

## TL;DR

Unblocked the entire team's Microsoft 365 connect flow (silent OAuth defect, was bouncing every non-admin teammate to "Need admin approval" for over a day), shipped the per-code dossier page + optimistic concurrency on job-codes + invoice hero drop zone + unified receipt/invoice intake on /finance/invoices, and delivered a Wolfpack-branded Ferrari dealer network audit deliverable for an external pitch. Five PRs merged to production. The M365 hot fix is two lines; the surrounding work was a single push-train cleared in the same session.

## Commits

### Hot fix (Microsoft 365 connect for non-admin teammates)
| SHA | What |
|---|---|
| `4bc68ac` | **fix(ms-auth): swap prompt=consent for prompt=select_account on OAuth start** ([#99](https://github.com/the-wolfpack-agency/wolfpack-apex/pull/99)). The prior `prompt=consent` parameter forced Microsoft to bypass cached tenant admin consent on every sign-in, which silently lands non-admin users on "Need admin approval" even when the tenant grant is fully in place. Trade-off acknowledged: lose automatic scope refresh when we add new scopes; mitigation is an explicit "Reconnect" button (TODO). |

### Features
| SHA | What |
|---|---|
| `1e5765b` | **feat(finance): unify invoice + receipt intake on /finance/invoices** ([#100](https://github.com/the-wolfpack-agency/wolfpack-apex/pull/100)). Two-tab segmented control above the hero drop zone routes invoice mode to the existing AP queue flow and receipt mode to `/api/job-codes/scan-receipt`, then redirects to `/job-codes?pending_scan=<id>` where the cascading category → code apply modal auto-opens. New GET endpoint `/api/job-codes/scan-receipt/[id]` for receiving-page rehydration. `prefilledScanId` + `onPrefilledHydrated` props on `ReceiptUploadButton`. Analytics: `system.scan_document_routed`. |
| `352450c` | **feat(finance): hero drop zone replaces small upload button on /finance/invoices** ([#98](https://github.com/the-wolfpack-agency/wolfpack-apex/pull/98)). Full-width drag-or-click drop zone with page-wide drag detection, view-only hint for non-managers, spinner-locked cursor during upload. |
| `57ab79f` | **feat(jobcodes): per-code dossier at /job-codes/[code]** ([#96](https://github.com/the-wolfpack-agency/wolfpack-apex/pull/96)). Header card, rollup cards (Spend YTD/MTD, PO Amount Remaining, Receipt count, Last activity), tabs for Receipts and Activity. On-demand SQL with indexed lookups, no materialized view. `system.job_code_dossier_viewed` analytics. |

### Fixes
| SHA | What |
|---|---|
| `5373a87` | **fix(jobcodes): optimistic concurrency + diff-aware cell writes** ([#97](https://github.com/the-wolfpack-agency/wolfpack-apex/pull/97)). When two users edit the same job-code cell, the second write was silently overwriting the first. New behavior: diff-aware apply skips cells whose new value equals current, conflict detection returns HTTP 409 with `{conflicts: [{column, currentValue, requestedValue}]}`, blocking `ConflictDialog` lets the user choose Keep theirs / Overwrite / Cancel. Conflict audit reuses `instinct_job_codes_edits` with `graph_error LIKE 'conflict_detected:%'`. Graph workbookRange PATCH lacks `If-Match` per Microsoft spec, so the fallback is pre-write-read + compare. |

## Numbers

| Metric | Value |
|---|---|
| PRs shipped (merged to main) | 5 |
| New routes | 2 (`/job-codes/[code]`, GET `/api/job-codes/scan-receipt/[id]`) |
| New components | 3 (`CodeDossierView`, `ConflictDialog`, the inline drop-zone toggle on InvoicesPanel) |
| New tests | 58 across unit / contract / UI / E2E |
| Files changed | 26 created, 17 modified |
| Production verification | Live and confirmed via `curl /api/auth/microsoft-start \| grep prompt=select_account` |

## Operational changes (M365 rollout)

| Step | Status |
|---|---|
| Tenant admin consent granted on canonical Azure App (`cb670432-653d-4195-b826-070380d83e99`) for tenant `e8c58440-91b0-4ddc-bdb1-e33ab22986b8` | Done |
| Users explicitly assigned in Enterprise App → Users and groups (defense-in-depth) | Ashley, Alicia, Nick H, Hoxsie |
| Connected and verified | Nick H (CTO), Ashley, Max |
| Connect-instructions drafted but not yet sent | Jorge |
| Pending team rollout | Alicia, Meghan, David |

## External deliverable (AgenticQA, separate repo)

| Artifact | Path |
|---|---|
| Reusable URL audit runner | `AgenticQA/scripts/client_url_audit.py` |
| Ferrari dealer network full technical report | `AgenticQA/docs/ferrari-dealer-network-audit-2026-05-21.md` |
| One-pager (markdown source) | `AgenticQA/docs/ferrari-dealer-network-onepager-2026-05-21.md` |
| One-pager (Wolfpack-branded PDF) | `AgenticQA/docs/ferrari-dealer-network-onepager-2026-05-21.pdf` |
| Email draft for Hoxsie | `AgenticQA/docs/ferrari-dealer-network-email-to-hoxsie-2026-05-21.md` |

Audit findings: ten platform-wide defects across both Ferrari dealer URLs sampled. Most notable: `X-Frame-Options: allow-from http://localhost:4200` (Angular dev port promoted to production). Pitch insight: both sites byte-identical at the platform layer, so one engagement = network-wide impact = recurring contract opportunity with the network operator.

## What did NOT ship

- Per-code dossier link from `JobCodesTable` rows (deferred to a small follow-up commit so PR #96 stayed scoped to the dossier surface itself).
- "Reconnect (refresh permissions)" Settings button (deferred from PR #99; needed before adding new MS scopes in future).
- Microsoft Partner Center publisher verification for Wolfpack Instinct (removes "unverified" badge on user consent screens; ~15 min, not blocking).
- Mail.Send (Application) scope audit (flagged earlier in session, deferred to next pass).

## Lessons logged to memory

- `feedback_oauth_admin_consent_tenant_url.md` — when "Need admin approval" persists after clicking Grant admin consent in Azure portal, use the tenant-pinned `/{tenant}/adminconsent?client_id=...` URL instead. Azure portal silently consents in whichever directory the admin is currently in.
- `feedback_read_our_own_code_first_on_third_party_bugs.md` — when a bug looks like a third-party platform problem (OAuth/IAM/cloud), grep our source for how we call that service BEFORE theorizing about the third party's configuration. Today's Ashley M365 incident cost over an hour because we theorized about Microsoft tenant state when the bug was `prompt=consent` hard-coded in our own OAuth URL builder.
- `feedback_no_quick_one_phrasing.md` — never use "Quick one" / "Quick note" / "Quick favor" or similar throat-clearing openers in drafts sent on the CTO's behalf.
