# Wolfpack Instinct

> A team's existing systems do not lack data. They lack a layer that connects
> the data into action, learns from every interaction, and improves on a
> weekly cadence without IT intervention. That is Instinct.

## What Instinct is

A chat-first agent that lives inside your tenant and speaks to every tool
in your stack. It answers questions, fills forms, executes actions, and
keeps your integrations healthy. Most requests resolve without ever
touching an AI model, so costs stay bounded and behavior stays auditable.

The same chat surface that books a meeting can pull a Salesforce
opportunity, draft a Teams message, file a To-Do task with its real list
selector, and flag an overdue invoice in QuickBooks. Each surface is a
"widget" rendered inline. Adding a new one for your stack is a half-day,
not a quarter.

## Three things only Instinct does

### 1. Lives in your tenant

Single deployment on Vercel. Your domain optional (`instinct.yourcompany.com`).
OAuth bound to your workspace. Audit-logged. Nothing leaves your boundary
unless you point a connector at it.

### 2. Learns from your team's vocabulary

Every prompt that does not match a deterministic tool is logged. The admin
dashboard surfaces a ranked backlog of what your team actually asked for.
The next widget targets the top of the list. No surveys, no roadmap
guessing, no waiting on a vendor's quarterly release.

### 3. Watches your integrations while you sleep

A nightly probe checks every integrated vendor. Connectivity, schema drift,
token expiry. Your operations team gets a Slack alert before users see a
500. Your Salesforce admin changes a required field, Instinct picks it up
the next morning and updates the form. No tickets.

## Day-in-the-life examples

* **Morning**: "briefing" returns greeting, today's schedule, action items,
  pre-brief for next meeting.
* **Lookup**: "find the deal for Acme" surfaces the CRM record with
  vendor-native badging and a link to the source.
* **Action**: "create a $50k deal with Acme" opens a form with fields
  pulled live from your Salesforce schema, custom fields included.
* **Cross-tool**: "emails to Hoxsie about the proposal" returns clickable
  rows that deep-link to Outlook.
* **Followthrough**: "create task to follow up Tuesday" opens a form with
  your real To-Do lists in the dropdown. Submit writes through and returns
  the deep link.

Each of these resolves in under a second, with no LLM call required.

## How a Wolfpack engagement deploys it

### Phase 0: Pre-engagement

We provision your Instinct instance on Vercel during the week before
kickoff. Your IT team approves the OAuth scopes (the same scopes any
Microsoft 365 plus CRM tool would request). No on-premises footprint.

### Phase 1: During engagement (weeks 1-2)

Your engagement deliverables are ingested into Instinct as they are
produced. Your CRM connects via OAuth. Your team's first interaction is
asking it about something the Wolfpack team is doing for them; it answers
from the materials they already see in deliverables.

### Phase 2: Mid-engagement value session

A 30-minute session shows your team their dashboard: which prompts are
landing, which are not, what your team wants that does not exist yet. The
Wolfpack engineer ships the top unmet-intent widget that week.

### Phase 3: End of engagement, your decision

You see the data. Either Instinct is already integrated into how your team
works, or it did not take. The decision is made on facts, not promises.

If you keep it: three retainer tiers (Lite, Standard, Embedded) sized to
your active user count plus the cadence of new connectors you want.

If you do not: we hand you the codebase under an existing-license clause,
export your data, and step away. No transition pain.

## What you keep, either way

* Every interaction emits a typed event your operations team owns. Audit
  trail is yours.
* Your Brain content (any document ingested) exports back as files.
* The OAuth credentials live in your workspace's secret store.
* The deployment is yours to keep running for as long as the tokens are
  valid (months), even with no ongoing support.

## How Instinct is different from a generic AI assistant

| Generic AI chat | Instinct |
|---|---|
| Lives in vendor cloud | Lives in your tenant |
| Pulls knowledge from training cutoff | Pulls from your live CRM, calendar, inbox, docs |
| One-shot answers | Persistent learning loop, weekly capability gains |
| Per-token cost on every request | Deterministic-first, LLM as fallback only |
| No integration health awareness | Nightly probes, drift detection, Slack on regression |
| Cannot write to your systems | Forms write through with your tenant's audit trail |

## What it would cost to build internally

Comparable capability at a typical mid-market company:
* Connector framework with OAuth refresh and audit: 8-12 weeks of senior eng
* Describe-driven form layer: 4 weeks
* Persistent learning loop with admin dashboard: 6 weeks
* Nightly health probe with Slack integration: 2 weeks
* Total ballpark: 5-7 months and a senior engineer fully allocated, before
  the first widget your team actually uses.

Instinct is roughly two days from your IT approval to your team's first
useful interaction.

## Next step

Ask Wolfpack to bundle an Instinct instance into your next engagement at
no additional cost. You see real value or you do not, on your timeline.

---

*Contact: Nick Homyk, CTO. homyk@thewolfpack.agency*
