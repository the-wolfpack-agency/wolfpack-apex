# Monthly security review

A short checklist for the first working week of each month. The automated checks do the looking; this review is where a person reads what they found and does the parts no script can. Allow about an hour.

Who: the CTO, or whoever the CTO names as reviewer for the month. When: the first working week of the month, after the Entra audit has run on the 1st. Record the outcome (what was found, what was changed, what was accepted and why) in that month's handoff note, and save the Entra audit report next to it.

How each automated check is set up and run is in [scheduled-checks.md](scheduled-checks.md).

## 1. Read the automated reports

| Check | Where to look | What a pass looks like | If it fails |
| --- | --- | --- | --- |
| Supply chain (daily) | latest run of [security-supply-chain](https://github.com/the-wolfpack-agency/wolfpack-apex/actions/workflows/security-supply-chain.yml) | no critical findings; high findings each have an open fix or a written reason | Malware, a known-compromised match, or a GhostAction high is an incident: stop and follow step 6. Critical or high CVEs go to the owning repository's maintenance queue. |
| Entra app audit (monthly) | [security-entra-audit](https://github.com/the-wolfpack-agency/wolfpack-apex/actions/workflows/security-entra-audit.yml) run on the 1st | no unused app with a live credential; every sensitive permission is one we decided on; nothing expiring unplanned | See steps 2 and 3. |
| AI spend (daily) | the month's runs of [security-ai-spend](https://github.com/the-wolfpack-agency/wolfpack-apex/actions/workflows/security-ai-spend.yml) | no spike or unexplained new AI resource | A spike nobody can explain: rotate that resource's keys the same day (new key in use first, then revoke the old). |
| Deployed surface (weekly and after each deploy) | [security-surface](https://github.com/the-wolfpack-agency/wolfpack-apex/actions/workflows/security-surface.yml) | no medium or higher on any site | Fix in the site's repository; re-run the workflow against that URL to confirm. |

A run that says **SKIPPED** is not a pass. Configure the missing secret it names.

## 2. Exchange: are the Mail.Send apps actually limited?

The Entra audit lists every app with tenant-wide `Mail.Send` (six on 2026-10-24). Tenant-wide means the app can send as any mailbox in the company. Microsoft Graph cannot tell us whether Exchange limits that, so this step is manual.

The rule to know: Exchange "RBAC for Applications" permissions are added to Entra permissions, never subtracted from them. While an app still holds the tenant-wide grant in Entra, an Exchange scope narrows nothing. Only an older Application Access Policy can constrain an Entra grant. ([Microsoft's page](https://learn.microsoft.com/en-us/exchange/permissions-exo/application-rbac), FAQ.)

1. Open PowerShell and run `Connect-ExchangeOnline` as an Exchange administrator.
2. `Get-ApplicationAccessPolicy` lists any policies that constrain Entra grants.
3. `Get-ManagementRoleAssignment -RoleAssigneeType ServicePrincipal | Format-Table Name,Role,App,CustomResourceScope` lists Exchange-scoped grants.
4. For each Mail.Send app, pick a mailbox it must NOT be able to send as and run `Test-ServicePrincipalAuthorization -Identity <app id> -Resource <that mailbox>`.
5. An app with tenant-wide Entra Mail.Send and no Application Access Policy is unlimited. To fix it without breaking it: create a management scope for the one sending mailbox, assign `Application Mail.Send` in Exchange with that scope, confirm the app still sends, then remove the Mail.Send grant from the app in Entra (Entra admin center, the app, API permissions).

## 3. Credentials older than 12 months, or expiring

The Entra audit lists secrets and certificates valid for more than 12 months and any expiring within 30 days. For each one still needed, rotate in this order so nothing goes down:

1. Add a new credential with an expiry of 12 months or less.
2. Put it into the place the app reads it from (Vercel environment variable, GitHub secret, Key Vault) and deploy.
3. Confirm the app works on the new credential (a real send or call, not a guess).
4. Only then delete the old credential in the Entra admin center.

If an app is not needed, delete its credential, or the app. The Entra audit's "unused" rule cannot run until the tenant has Entra ID P1 or P2, so for now decide "needed" from the consuming app's own history (when did it last send or call).

## 4. Copilot and Power Platform admin review

No script covers these yet.

1. [Microsoft 365 admin center, Copilot](https://admin.microsoft.com/#/copilot): which agents are published to the organization, and who can create them. Anything nobody recognizes is removed or its owner found.
2. [Power Platform admin center](https://admin.powerplatform.microsoft.com/): environments list (unexpected environments), data policies (DLP) on the default environment, and connections that use a shared or service account.
3. [Copilot Studio](https://copilotstudio.microsoft.com/): agents with authentication set to "No authentication", and agents with connectors that can send mail or write files.
4. Note the Copilot Studio cost line in the AI spend report against what was expected for the month.

## 5. Keep the threat list current

Read the month's advisories that touched anything we use (npm, PyPI, GitHub Actions, Microsoft 365, Next.js, Vercel). For each one that applies:

- A malicious package or image release: add it to `security/known-compromised.json` with its primary source, so the daily sweep checks every repository for it.
- An attack on our sites: turn it into a Forcefield rule using [threat-to-rule.md](threat-to-rule.md).
- A new site or a new repository: add the site to `scripts/security/surface-sites.json`; new repositories are swept automatically.

## 6. If something is found that is an incident

Malware in a lockfile, a known-compromised release, a workflow change outside a merged pull request on a default branch, or a spend spike nobody can explain:

1. Do not run the affected install again (a stealer runs on every start).
2. Rotate every credential the affected machine, runner or app could read. New credential in use first, then revoke the old.
3. Rebuild from a clean state rather than cleaning in place.
4. Write down what happened and add the rule or list entry that would have caught it sooner.
