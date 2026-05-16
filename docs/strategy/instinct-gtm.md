# Wolfpack Instinct: GTM strategy

> Living strategy doc. CTO + CEO source-of-truth for positioning, pricing tiers, design-partner program, and revenue model. Updated as we learn. Last revised: 2026-05-16.

## 1. The honest opportunity

Wolfpack has built three things that, taken together, are uncommon in agency-land:

1. **A working multi-system AI assistant** (Instinct) that already aggregates CRM + mail + calendar + GitHub + knowledge into one chat surface, with a learning loop that captures org-wide corrections.
2. **A delivery muscle**: a small team that has shipped Wolfpack Auto, Wolfpack Weekend, AgenticQA, and Instinct in months, not years.
3. **An agency book**: existing client relationships across mid-market services businesses (dealer groups, brand engagements, professional services) that buy on relationship and outcomes, not feature lists.

The mistake to avoid: turning this into "another AI productivity SaaS" priced at $20/user/mo. There are 200 of those, they all lose money, and Wolfpack has no advantage in that race.

The strategy below leans into what Wolfpack *uniquely* has: client trust, change-management chops, and the ability to translate generic platform capability into vertical-specific outcomes.

---

## 2. Positioning

### What we are
**"One place for the answer your data already has."** A team-grade AI assistant that ties an organization's existing systems (Microsoft 365, CRM, GitHub, internal docs) into a single chat surface, with structured create-actions, source attribution, and a learning loop that gets smarter every time someone corrects an answer.

### What we are NOT
- A general-purpose chatbot (those exist; we lose to Copilot/Gemini on price)
- A CRM (that's Salesforce/HubSpot)
- A workflow builder (that's Zapier/Power Automate)
- A point AI feature (that's any of 50 startups)

### Why Microsoft, Google, and Salesforce won't crush us here
Each of the platform players has a **structural conflict** that prevents them from consolidating other vendors' data:
- **Microsoft Copilot** has to favor Microsoft data; pulling Salesforce/HubSpot into Outlook chat is a non-priority because it commoditizes Dynamics.
- **Salesforce Einstein** can't surface MS calendar / Teams / GitHub without making Salesforce optional.
- **Google Workspace AI** doesn't speak fluent Salesforce/HubSpot for the same reason.

Our position is **multi-vendor by design**, which is a sustainable wedge as long as we don't become a vendor ourselves on either side.

### The 30-second pitch
> "Your team's institutional memory, in one chat. Ask any question your data already has the answer to. Your CRM, your inbox, your calendar, your GitHub, your knowledge base. Get the answer in plain English with a link to the source. Correct it once, the whole team learns. No more 'hunting through five tabs.'"

---

## 3. Ideal Customer Profile (ICP)

Start narrow. Three concentric circles:

### Tier A: beachhead (year 1)
**Mid-market professional-services firms, 25–150 employees, multi-system stack.**
- Run on Microsoft 365 + Salesforce or HubSpot + GitHub or similar dev tool
- $5M–$50M ARR
- Already pay for at least one AI tool (validates spend appetite)
- Leadership feels the "context tax" of switching between 8+ tools
- Examples: marketing agencies, boutique consultancies, dev shops, small law firms, financial advisory groups

### Tier B: expand (year 2)
**Dealer groups, franchised SMBs, regulated mid-market.**
- Wolfpack Auto already has dealer relationships → cross-sell Instinct as the "team brain" alongside the dealer platform
- Regulated industries (insurance, fin, healthcare) value the audit-log + source-attribution properties Instinct already has

### Tier C: enterprise (year 3+)
**Multi-BU enterprises that want the platform but need SSO, data residency, on-prem.**
- Not a year-1 priority. Building enterprise sales motion is a separate company.

### Buyers vs. users
| | Buyer | User |
|---|---|---|
| Tier A | COO / Ops Director / CTO | Sales reps, account managers, leadership |
| Tier B | Dealer principal / Owner | GMs, sales managers, F&I |
| Tier C | VP IT, CIO | Knowledge workers across departments |

**Champion = the buyer.** In Tier A the COO/CTO is the same person evaluating tools and feeling the pain. Don't try to bottom-up adopt; sell to the top.

---

## 4. The product ladder

Three tiers, designed so each step changes the buyer's expectation and price anchor.

### Tier 1: Instinct Starter: $12 / user / month
**The MS 365 wedge.** Lowest-friction onboarding. Customer brings their own Microsoft tenant; we wire calendar / mail / Teams / GitHub. No CRM connector. Token budget capped.

Capabilities:
- Calendar Q&A, mail search, GitHub query, MS To-Do + To-Do task creation
- Knowledge base ingestion (file upload)
- Single-workspace, single-tenant install
- Email + chat support, 48hr SLA

Why this exists: low-friction signup, gives the team a reason to use it daily, sets the seat anchor for a paid product. Not the profit center.

**Target conversion: 30% of Starter → Pro within 6 months.**

### Tier 2: Instinct Pro: $35 / user / month
**The wedge that pays the bills.** Adds the CRM layer + structured actions + cross-system queries that justify the price.

Adds:
- Salesforce / HubSpot connector with OAuth
- Chat-action forms (create deal, contact, OKR, feature request)
- Source-attribution badge in chat (multi-CRM workspaces tell which system answered)
- Conversation history + sidebar (already shipped)
- Inline RAG over your client docs
- Phone + Slack support, 24hr SLA
- Org learning loop (corrections propagate across users)

**Target ARPA (annual revenue per account) at Pro: $25K / year @ 60-seat workspace.**

### Tier 3: Instinct Managed: $X / month, custom
**The agency-led tier. Where Wolfpack actually wins.** Not a per-seat product; a managed engagement.

Includes:
- Everything in Pro
- Dedicated success engineer (Wolfpack employee assigned to your account)
- Custom connector builds (your industry's tool isn't in our preset library? We add it.)
- Brand-customized chat surface (your colors, your logo, your domain)
- Migration support from legacy knowledge silos (SharePoint sprawl, Notion sprawl)
- Quarterly business review with concrete usage + ROI dashboards
- Compliance audit support (audit-log delivery, retention policies, SSO)
- Optional: on-prem / VPC deployment

**Target ARPA at Managed: $150K–$500K / year. Wolfpack's existing client relationships should make the first 5–10 of these warm intros, not cold sales.**

### Why this ladder works
1. The price ratios (12 → 35 → custom) train the buyer that **going up is a meaningful unlock**, not just more seats.
2. Each tier matches Wolfpack's delivery capacity at scale: Starter = self-serve, Pro = light sales touch, Managed = agency engagement (what you already know how to do).
3. Tier 3 sells time + relationship + custom work (the highest-margin part of an agency business) wrapped in the recurring software pricing model.

---

## 5. Unbundled wedges (the underrated revenue stream)

Selling the full Instinct platform is a multi-month sale. **Unbundling parts of it lowers buyer friction and gives Wolfpack 5+ smaller revenue streams.** Each can be sold standalone OR as a "starter pack" that converts to full Instinct later.

| Wedge product | What it does | Sells to | Estimated price | Effort to productize |
|---|---|---|---|---|
| **CRM hygiene scanner** | Daily report: deals missing close date / stage, stale records, contacts without owner. Plain-English digest mailed to sales managers. | Sales ops at SF/HubSpot shops | $200 / seat / mo (or $1,500 flat for org < 50 reps) | LOW (we already have the connector + aggregate logic) |
| **Meeting prep bot** | Pre-meeting brief: who's attending, last touchpoint, deal status, open threads. Posted in Teams 30min before any external meeting. | Account managers, sales | $15 / user / mo | LOW (calendar + mail + CRM joins; we have all three) |
| **Inbox triage** | Once a day, ranks unread emails by "needs response" with reasoning. Drops them in a "today" folder. | Knowledge workers swamped by email | $20 / user / mo | MEDIUM (need a ranker + a folder writer; mail/send is the closest we have) |
| **Onboarding bot** | New-hire Q&A trained on company docs. Embedded in Slack / Teams. Logs unanswered questions so HR can fix the gap. | HR / People ops at growing companies | $5K setup + $300 / mo | LOW–MEDIUM (RAG over docs, which Instinct already does) |
| **Compliance Q&A** | Regulated industry Q&A grounded in policy docs. "Can I do X under SOC2?" with citation. Audit log of every Q+A. | RegOps at insurance / fin / healthcare | $5K setup + $1,500 / mo | MEDIUM (need stricter source-citation enforcement + retention) |
| **GitHub for non-eng** | Translates "what shipped this week, what's blocked, what's on fire" into a business-language digest. Slack / email. | Non-technical leaders at dev-heavy shops | $150 / mo flat (per repo group) | LOW (we have the GitHub tools; just need a daily-digest scheduler) |
| **AgenticQA-as-a-service** | Run AgenticQA's scanners against a client's repos weekly, deliver a prioritized findings report. | Engineering leaders without a security team | $2K / mo / repo | MEDIUM (AgenticQA exists; productize the report) |
| **Calendar concierge** | Schedule meetings across N attendees + N calendars, find optimal slot, handle the back-and-forth. | EAs, founders, biz-dev | $30 / user / mo | MEDIUM (calendar + mail/send + a scheduling brain) |

### Why this matters
1. **Lower CAC.** A $300/mo onboarding bot is a no-brainer for an HR director; $35/seat × 50 seats is a budget meeting.
2. **Pricing power on the full platform.** When clients have already paid for two wedges, "everything in one chat" is an obvious consolidation play.
3. **Diversification.** If Instinct's enterprise tier sales cycle slows down, the wedges keep recurring revenue stable.
4. **Reuses what's built.** Every wedge above is built on code already in the Instinct repo: the engineering cost is productization (packaging, docs, billing, support), not feature work.

### Recommended first three wedges to ship
1. **CRM hygiene scanner** (most defensible, leverages our unique aggregation), 4-week productization
2. **Meeting prep bot** (highest stickiness, daily-use), 4-week productization
3. **GitHub for non-eng** (gateway for tech-curious COOs), 2-week productization

---

## 6. GTM motion: design partners first

### Phase 0: internal dogfooding (current state, complete)
Wolfpack uses Instinct daily. All connectors verified live. ~437 tool tests green. Source-attribution + form-based actions shipped.

### Phase 1: design partner cohort (next 90 days)
**5–10 mid-market clients on Instinct Pro at $0–$1K/mo for 6 months in exchange for:**
- Weekly check-in (Wolfpack-led; we drive)
- Permission to publish a written case study
- Permission to record + reuse a customer video
- Access to their actual usage data (with PII-stripped analytics)
- Naming rights on roadmap features they request

Why this works:
- Validates pricing without setting a public price floor
- Generates the social proof that lets you charge $35/seat/mo to the *next* 50 customers
- Tests the support load before scaling
- Surfaces the connector / integration gaps that would otherwise blindside enterprise sales

**Recruit from:**
1. Existing Wolfpack agency clients (warm; the design-partner ask is a soft sell, not a contract change)
2. Wolfpack Auto dealer customers (existing trust, immediate cross-sell opportunity)
3. Wolfpack Weekend brands (the marketing connection lets you pitch this as a "team brain" for their internal ops)

### Phase 2: managed-tier sales (months 4–9)
Take the 2–3 best design partners and **convert them to paid Managed-tier contracts ($150K+ ARR each).** Use those case studies to outbound to similar firms.

This is the phase where Wolfpack's agency motion shines: relationship-led sales, custom scoping, success-engineering delivery. You already do this for branding work; you're just selling a different deliverable.

### Phase 3: Pro tier self-serve (months 9–15)
Open up self-serve Pro signup once:
- The product is stable for 6 months under design-partner load
- You have at least 5 paid Managed customers (revenue floor)
- You have 3 published case studies
- Support tooling can handle 10x volume without 10x people

Premature self-serve is the most common SaaS-from-services failure mode. Don't.

### Phase 4: Starter tier wedge (year 2)
Open the $12 MS 365 starter tier as a top-of-funnel motion. By now Pro is the anchor product; Starter is the lead magnet.

---

## 7. Revenue model: three-year sketch

These are **directional, not projections.** Reality will diverge. The point is to see what the shape has to look like for this to be worth doing.

| | Year 1 | Year 2 | Year 3 |
|---|---|---|---|
| **Managed-tier customers** | 3 | 10 | 25 |
| **Avg ARPA Managed** | $150K | $200K | $250K |
| **Pro customers** | 5 | 40 | 150 |
| **Avg ARPA Pro** | $25K | $30K | $35K |
| **Wedge subscriptions** | 20 | 100 | 400 |
| **Avg ARPA wedge** | $5K | $6K | $7K |
| **Starter (self-serve)** | 0 | 200 | 1500 |
| **Avg ARPA Starter** |: | $1K | $1.2K |
| **Annual Recurring Revenue** | $675K | $3.4M | $11.6M |
| **Wolfpack delivery headcount on Instinct** | 4 | 8 | 18 |

If those numbers are even directionally right, year 3 Instinct is materially larger than the existing agency book. That's the prize.

The failure mode: Year 1 ARR comes in at $200K not $675K, you've hired the headcount to deliver, and the agency is paying for it. The discipline below is meant to prevent that.

---

## 8. What kills this plan

A short, honest list. Each of these has happened to companies trying the same playbook:

1. **Building Pro features before selling Managed.** If you spend Q3 building self-serve onboarding instead of closing your first $150K customer, you've optimized for the cheap tier before the expensive tier exists.

2. **Underpricing the Managed tier.** The instinct (no pun) is to discount to win the first 3 deals. Don't. The price you set anchors every future deal. $150K is the floor.

3. **Saying yes to custom features for free.** Design partners will ask for "small" custom builds. Every one is a no unless it's on the public roadmap. Else you've sold consulting at $0/hr.

4. **Cannibalizing the agency.** If Instinct Managed delivery competes with creative-agency revenue for the same team, internal politics kill it. Staff this as a separate P&L from day one.

5. **Feature creep into "AI for everything."** Instinct's wedge is *multi-system answers*, not "we also have a code generator and image creator and presentation maker." Every feature outside the wedge dilutes the positioning.

6. **No customer success function.** Managed-tier customers churn if they're not actively used. A success engineer per 5 accounts is the right ratio for year 1. This is also Wolfpack's structural strength: you're an agency, you know how to do account management.

7. **Premature publicity.** Announcing "Wolfpack Instinct: the AI team brain" before you have 3 paying customers means competitors copy the positioning before you've established it. Stay quiet through Phase 2.

---

## 9. Immediate next actions (this week / next week)

These are the concrete steps to start executing this plan, in order:

1. **Pick 10 design-partner target accounts** from the existing client roster. Have a one-line "why them" for each. *(CTO + CEO, 1 hour)*
2. **Draft the design-partner offer doc** (one page: what they get, what we get, the 6-month exit). *(CTO, 2 hours)*
3. **Build a 2-slide pitch** specifically tuned to mid-market services firms. No more, no less. *(CTO + design, 4 hours)*
4. **Pick the first wedge product to ship** as a standalone (recommend: CRM hygiene scanner). Scope it for a 4-week ship. *(CTO, 1 day to scope)*
5. **Reserve `instinct.wolfpack.agency` or similar URL** with a one-page lander that says nothing more than "AI team brain for mid-market services firms. Limited design-partner spots open. Email cto@..." *(half a day)*
6. **Schedule 5 design-partner pitches in week 2.** Goal: 3 signed by end of month.

Everything else (full marketing site, paid acquisition, public pricing page, content engine) is **deferred until you have 3 paid design partners**. Premature investment in those is the most common waste of money in this phase.

---

## 10. Open questions for the CEO

Things this plan doesn't answer that the CEO + CTO need to decide together:

1. **Is Instinct staffed as a separate P&L or a line item under Wolfpack Agency?** Separate is recommended; the partnership economics differ.
2. **Are you willing to turn away agency work to protect Instinct delivery capacity?** Year 2 is when this conflict becomes real.
3. **What's the bar for "we've succeeded"? $1M ARR? $5M? An exit?** Different bars imply different execution paces.
4. **Equity carve-out for Instinct contributors?** A SaaS product inside an agency is unusual; the team that builds it usually wants a different upside.
5. **First wedge product: CRM hygiene, meeting prep, or GitHub digest?** All three are short ships. Pick the one that maps to the warmest existing-client conversation you can have *this week*.

The answers shape everything downstream. Worth a 90-minute working session before the design-partner outreach starts.
