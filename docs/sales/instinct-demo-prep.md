# Instinct Demo Prep (Internal)

> Internal-only prep notes. Candid. Keep this off the client-share path. The
> client-facing artifact is `instinct-leave-behind.md` in the same folder.

## The hook (defensible version)

Instinct is the integration layer that sits inside a client's tenant. Same
OAuth scopes, same audit trail, same data boundary. It learns what their team
types and builds the tooling to match. It's the agent layer Labs companies
(Anthropic, OpenAI) structurally will not build because it would compete with
their enterprise sales motion.

Three things only Instinct gets right at once:

1. **Lives in the client's tenant.** Single Vercel deployment, their domain
   optional, OAuth bound to their workspace. Nothing leaves their boundary
   unless they point a connector at it.
2. **Deterministic-first.** Most requests resolve without an LLM call
   (calendar, inbox, tasks, CRM lookups, forms). LLM fires only on real
   fallback. Cost stays bounded; behavior stays auditable.
3. **Self-improving.** Every unmet intent gets logged, the admin dashboard
   shows the backlog, the next week's widget targets the top of the list. The
   system genuinely learns from usage, not from training-set scrape.

**What it is not (defend honestly):**

- Not a ChatGPT replacement. Specifically the integration plus memory layer
  AI labs do not build.
- Not magic plug-and-play for every tool. Each new vendor is roughly a
  half-day of connector work. We can do it during the engagement.
- Not infinite. "Interacts with entire platform" means everything we have
  integrated. We have shipped MS 365, Salesforce, HubSpot, QuickBooks,
  GitHub. Anything else is a connector away.

## Demo flow (12 minutes)

Lead with what the buyer's team will do every day, not with architecture.

### 1. The morning glance (2 min)

Type `briefing` in chat.

* Inline panel shows greeting (by name), today's schedule, action items,
  meeting pre-brief with picker.
* Click into a meeting, land on its detail.
* Land this line: "Your team opens this once. They get what would have taken
  six tabs."

### 2. Calendar widget (1 min)

Type `calendar`.

* Click a day, click an event, "Open in Outlook" deep-links out.
* Land: "We are a portal, not a wall."

### 3. CRM lookup (2 min)

Type `find the deal for Acme`.

* Vendor-badged response. Click into the deal in Salesforce.
* Then type `create a $50k deal with Acme`. The form shows fields pulled live
  from their Salesforce schema, including their custom fields.
* Land: "When you add a custom field to Salesforce, this form picks it up
  tomorrow morning. No redeploy, no ticket to us."

### 4. Cross-tool action (2 min)

Type `find emails to hoxsie about the proposal`.

* Clickable subject links open Outlook.
* Then `create task to follow up with hoxsie next Tuesday`. Form opens, list
  dropdown populated, submit, deep link to /tasks.
* Land: "One chat, three tools, zero app-switching."

### 5. The moat: admin insights (3 min)

Open `/admin/insights`.

* Three feeds: unmet intents (the backlog), template registry (what every
  widget maps to), integration health (live status, drift alerts).
* Land: "This is how we know what to build next for you. Your team's actual
  phrasing, ranked. No surveys, no guess-work."

### 6. The autonomy layer (2 min)

Show the nightly Slack alert.

* "At 5am UTC, this system probed every integration in your stack, found
  Salesforce's token had drifted, and Slacked our channel before any user
  got a 500."
* Land: "Your integrations do not quietly rot. We know first."

Close with: "Everything you saw is in production. We did not build it for
this demo."

## Deployment plan: engagement-as-trojan-horse

### Phase 0: Pre-engagement scoping (1 week before kickoff)

* Identify the client's top 3 tools (likely MS 365 plus CRM plus accounting).
* Confirm SSO method (Okta, Azure AD, Google Workspace; have answers ready).
* Provision Instinct on Vercel. Custom subdomain if their security team
  prefers (`instinct.client.com`); default to Wolfpack-owned subdomain if
  they want zero IT lift.

### Phase 1: Engagement weeks 1-2, ambient deployment

* Brain-ingest every engagement deliverable as it is produced.
* Connect MS 365 plus the client's CRM via OAuth. Built-in describe-driven
  forms work day one.
* Wolfpack team uses Instinct visibly in client meetings. Pull up the
  dashboard. Ask Instinct to find materials. The buyer's team notices.

### Phase 2: Engagement weeks 3+, anchor the value

* Schedule one 30-minute "here is what your team is doing with Instinct"
  session. Show them their admin dashboard. Their unmet intents. Their most-
  used widgets.
* Build one custom widget for their #1 unmet intent. Show it shipped in
  days, not months.

### Phase 3: Engagement close, decision moment

* **Walk-away path:** deactivate instance, hand them an exit report (what
  they learned, top 10 patterns, what we would have built next).
* **Continue path:** convert to retainer. Three pricing tiers:
  * **Lite**: keep instance, MS 365 plus one CRM, hands-off. Per-seat
    monthly.
  * **Standard**: add one new connector per quarter. Dedicated Slack
    channel for unmet-intent triage.
  * **Embedded**: Wolfpack engineer drops in monthly to ship widgets
    against the backlog. Highest LTV, hardest to switch off.

Framing on the decision: "You have been using this for N weeks. Either it
is already irreplaceable, or it did not take. The data tells us which." You
are not selling; you are closing on a fact the data already shows.

## Counter-arguments to expect

### "Why not just use ChatGPT Enterprise?"

ChatGPT cannot render your Salesforce form, write to your To-Do, or alert
your team when your CRM's schema drifts. It is a chat surface, not an
integration. Operator is closer but still a separate browser session. Yours
stays in your tenant, your data never crosses an AI lab boundary. And
Anthropic plus OpenAI structurally cannot build this; it competes with their
enterprise sales motion.

### "How secure is this?"

Single-tenant deploy. OAuth bound to your workspace. JWT-authenticated.
Audit-logged with hash-chained integrity. Every probe plus action emits a
typed event you own. We do not see your data. We host the code that talks
to your tokens.

### "What about lock-in?"

Exit-any-time clause. Your Brain content is exportable. We hand you the full
event log. Your data stays yours because it never left.

### "This sounds like a Slack bot."

A Slack bot reacts to messages. This learns from misses, surfaces a build
backlog, monitors integrations nightly, and ships new capabilities each
week against your team's actual phrasing. Agent layer with a learning loop,
not a single-purpose response bot.

### "What's the cost?"

Engagement bundled. No extra invoice line during the proof-of-value period.
After engagement: per-seat retainer, sized to active user count. The
deterministic-first design means we do not burn tokens like a pure-LLM tool
would.

### "How fast can you stand it up?"

Hours to OAuth plus first widget answer. Days to Brain-ingest a full
document set. Weeks to fully reflect your team's vocabulary. The first
widget we ship for them in week 2 is when they realize they did not have
to file a ticket.

### "What happens if Wolfpack stops supporting Instinct?"

You would lose ongoing widget development. You would keep the deployed
instance, the data, and the integrations until tokens expire (months). We
would hand you the codebase under an existing-license clause. You are not
betting your operations on us being around. You are betting on us being
faster than your IT team at shipping integration features, which is a
different bet, and one the data tells you whether it is true.

## What to NOT promise

* A specific number of integrations. Each is real engineering work.
* "AI that replaces \[role\]". This is not that. It is a tool that makes
  existing roles roughly 30% faster on integration-heavy work. Quantifiable,
  defensible.
* Zero-touch IT setup. There will be an OAuth flow and likely an SSO chat
  with their security team. Do not oversell.

## Risks to flag internally

* **Integration sprawl.** Each connector is real work. Do not promise 50
  connectors in week 1.
* **Client IT pushback.** SSO, data residency, audit. Have answers ready.
* **Adoption.** Tech alone does not make people use it. Wolfpack team
  modeling usage during engagement is what makes it stick.
* **Lock-in concern.** Clients will worry. Counter with the export-anytime
  clause.
