# Wolfpack Instinct: Release Report 2026-07-29

## TL;DR
Shipped the Releases changelog end to end: a date-organized /releases page in
Instinct with an analytics dashboard, a release-notes pipeline that turns git
history into plain-English notes, and a backfill of every product's shipped
history. Alongside it, a cross-repo security and account remediation across
Auto, Instinct, and LMS.

## Releases changelog (Instinct)
### /releases page
A team-facing changelog at /releases. Navigate by month (year tabs appear only
when history spans years), so you see one month at a time instead of a long
scroll. Each release expands to a plain-English feature breakdown with a
"how to use it" note per change. Reachable from the sidebar and Cmd+K.

### Analytics dashboard
An at-a-glance strip across the top: total lines of code across all products,
number of products created, releases, and features shipped. The numbers are
derived from real data, not hardcoded.

### Products view
A toggle that isolates product-creation milestones into a dated lineup, so you
can see the range of Wolfpack products by the date each was created.

## Release-notes pipeline
### Generator
A deterministic script that reads git commits since the last release, uses the
existing AI gateway to write plain-English feature breakdowns, publishes them,
and emails the team through the shared Microsoft Graph mailbox. If the AI is
unavailable it falls back to a commit-per-entry release, so it never fails to
produce a report.

### Backfill importer
A one-time, idempotent importer that reads the hand-authored release reports
across every product repo and populates the page with real shipped history,
including a creation milestone per product and a per-product lines-of-code
count. Internal session notes are deliberately excluded so the page stays
feature-facing.

### API and data
A releases API (org-wide read, gated publish) backed by a new table, with every
read and publish wired into analytics and every publish written to the audit
log. Reads are shadow-safe.

## Security and account remediation
### Forgot-password flow (Auto)
The admin forgot-password flow works end to end again: the reset page is
reachable without a session, the admin sidebar no longer renders for logged-out
visitors, and the reset email actually sends (the send is now awaited so it
completes before the serverless function ends). Restored the account login path
by backfilling the missing MFA columns the login query expected.

### Dependency and code-scanning hardening
Cleared the open dependency alerts across Auto, Instinct, and LMS, and the code
scanning findings (pinned GitHub Actions to commit SHAs, removed a workflow
script-injection, fixed two static-analysis findings). Added a reusable Security
hygiene workflow to each repo that keeps findings from accumulating.
