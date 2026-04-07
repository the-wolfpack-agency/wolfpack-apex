# Wolfpack Agency — Complete Infrastructure & Cost Report

**Prepared for:** Hoxsie, CEO
**Prepared by:** Nick Homyk, CTO
**Date:** April 7, 2026
**Revision:** Hybrid LLM model (post April 6 architecture decision)

---

## Executive Summary

This report covers the complete infrastructure costs for both Wolfpack products:

- **Wolfpack Instinct** — Team intelligence platform (assistant, knowledge base, reports, analytics, briefings, financials, settings)
- **Wolfpack Auto** — Dealer management platform (inventory, leads, F&I, payments, payroll)

**Total monthly cost for both platforms combined: ~$120/month (range $107–124).**

| Metric | Value |
|---|---|
| Wolfpack Instinct (monthly) | $100.50–102 |
| Wolfpack Auto (monthly) | $6–22 |
| Combined annual estimate | $1,284–1,488 |

**Key change vs. April 6 report:** the team Assistant now runs on GPT-4o-mini (hybrid model approach) instead of Claude. The CTO development tool (Claude Max, $100/mo) is unchanged because it is the right tool for agentic coding workloads. Net savings: $5–15/mo today, with much larger implications for Wolfpack Auto at scale (see "Why hybrid matters" below).

---

## Why Hybrid LLM (Not Single-Vendor)

After evaluating single-vendor approaches, we adopted a **per-workload model** strategy:

| Workload | Model | Reason |
|---|---|---|
| **CTO development tool** (Claude Max, IDE coding loop) | Claude Opus 4.6 | Strongest agentic coding model. Used by one person. Fixed cost. |
| **Wolfpack Instinct team Assistant** (5 users, Q&A + briefings) | GPT-4o-mini | Cheapest credible model. Zero-token-first cache absorbs ~80% of queries before any LLM call. |
| **Wolfpack Instinct premium queries** (rare, complex reasoning) | GPT-4o | Mid-tier reasoning when mini isn't enough. <5% of traffic. |
| **Wolfpack Auto embeddings** | OpenAI text-embedding-3-small | Already in production. Pennies per month. |
| **Wolfpack Auto LLM features** *(future)* | GPT-4o-mini for templated content, GPT-4o for customer-facing | Multi-tenant unit economics demand the cheapest model that meets quality bar. |

**The hybrid approach is not primarily a cost decision today.** Today's savings are real but small (~$5–15/mo). The real value is unit-economics protection for Wolfpack Auto at scale and enterprise positioning for Instinct (Azure OpenAI option keeps client data inside the same M365 tenant). See the final section.

---

## Platform 1 — Wolfpack Instinct (Team Intelligence Platform)

AI-powered workspace for the entire Wolfpack team (5 members): Assistant, knowledge base, reports, discussions, feature requests, journal, client management, email templates, analytics, morning briefings, financials (CEO-only), and Microsoft 365 + QuickBooks integrations.

### Monthly Costs

| Service | Purpose | Plan | Monthly | Annual |
|---|---|---|---|---|
| **Claude Max** | Nick's development tool (IDE, Claude Code, building Instinct + Auto) | Max 5x (Personal) | $100.00 | $1,200.00 |
| **OpenAI API** *(GPT-4o-mini)* | Powers the Wolfpack Assistant + morning briefings for all 5 team members | Pay-as-you-go | $0.50 – $2.00 | $6 – $24 |
| Vercel | Hosting (wolfpack-instinct.vercel.app) | Hobby (Free) | $0.00 | $0.00 |
| Neon PostgreSQL | Primary database | Free | $0.00 | $0.00 |
| Qdrant Cloud | Vector search for knowledge matching | Free | $0.00 | $0.00 |
| Neo4j AuraDB | Knowledge relationship graph | Free | $0.00 | $0.00 |
| Resend | Email notifications (3,000/mo) | Free | $0.00 | $0.00 |
| Sentry | Error monitoring | Free | $0.00 | $0.00 |
| Microsoft Graph API | Calendar / email / contacts ingest (per-user OAuth) | Free | $0.00 | $0.00 |
| QuickBooks Online API | Financial data (CEO-only) | Free | $0.00 | $0.00 |
| **Instinct Subtotal** | | | **$100.50 – $102** | **$1,206 – $1,224** |

### Why the team Assistant is so cheap

Three reinforcing reasons the LLM line is sub-$2/month for a 5-person team:

1. **Zero-token-first architecture.** Every Assistant query first checks the cached knowledge base, then Qdrant semantic search, then Neo4j graph context. Roughly 80% of questions are answered without ever calling an LLM. The LLM is the fallback, not the default.
2. **GPT-4o-mini pricing.** $0.15 input / $0.60 output per million tokens. Five users at 20 messages/day with ~70% cache hit rate uses approximately 3 million tokens/month total — about $0.50.
3. **Per-LLM-call cost cap.** Every Assistant response logs token usage to analytics. If usage spikes, we have per-user budget enforcement ready to deploy from the existing analytics events.

### What every team member gets

- Wolfpack Assistant — AI-powered Q&A that learns from every interaction
- Knowledge Base — searchable team knowledge, compounds over time
- Morning Briefing — calendar + email + action items pulled from M365 (per-user, isolated)
- Reports — branded client reports, proposals, internal audits
- Discussions — threaded team conversations with resolution tracking
- Feature Requests — submit ideas, vote, track development
- Journal — team activity log + daily context
- Client Management — client profiles + communication tracking
- Email Templates — professional client emails generated instantly
- Analytics — usage insights, team activity, AI efficiency metrics
- Settings / Integrations — connect personal Microsoft 365 + (CEO) QuickBooks
- Financials *(CEO only)* — P&L, balance sheet, AR/AP aging, invoices

---

## Platform 2 — Wolfpack Auto (Dealer Management Platform)

Full dealer operations platform: inventory management, lead tracking, F&I, payments, payroll, compliance, analytics, and customer-facing dealer websites.

### Fixed Monthly Costs (Always On)

| Service | Purpose | Plan | Monthly | Annual |
|---|---|---|---|---|
| Vercel | Hosting dealer platform | Hobby (Free) | $0.00 | $0.00 |
| Neon PostgreSQL | Dealer data, leads, vehicles, deals, payroll | Free | $0.00 | $0.00 |
| Cloudflare R2 | Vehicle images and media storage | Free (10 GB/mo) | $0.00 | $0.00 |
| Qdrant Cloud | Semantic vehicle search | Free | $0.00 | $0.00 |
| Neo4j AuraDB | Customer journey + relationship tracking | Free | $0.00 | $0.00 |
| Resend | Lead notifications, invoices (3,000/mo) | Free | $0.00 | $0.00 |
| Sentry | Error monitoring | Free | $0.00 | $0.00 |
| Google Maps | Dealer location maps | Free ($200 credit) | $0.00 | $0.00 |
| NHTSA API | VIN decoding | Free (federal) | $0.00 | $0.00 |
| Let's Encrypt | SSL certificates | Free | $0.00 | $0.00 |
| NextAuth.js | Authentication | Free (open source) | $0.00 | $0.00 |
| OFAC / Treasury | Sanctions compliance screening | Free (federal) | $0.00 | $0.00 |
| **Fixed Subtotal** | | | **$0.00** | **$0.00** |

### Variable Costs (Usage-Based)

| Service | Purpose | Pricing | Est. Monthly | Est. Annual |
|---|---|---|---|---|
| Stripe | Payment processing | 2.9% + $0.30/txn | Varies* | Varies* |
| Twilio | SMS lead outreach | $0.0079/SMS | $5 – $15 | $60 – $180 |
| FAL.ai | AI background removal on vehicle photos | Pay-per-use | $1 – $5 | $12 – $60 |
| OpenAI | Text embeddings for inventory search | $0.02/1M tokens | $0 – $2 | $0 – $24 |
| **Variable Subtotal** | | | **$6 – $22** | **$72 – $264** |

\* Stripe fees only occur on actual transactions and are typically passed through to dealer or customer. There is no monthly fee.

---

## Combined Monthly & Annual Totals

| Category | Monthly | Annual |
|---|---|---|
| **Wolfpack Instinct (Team Platform)** | | |
| Claude Max (Nick's development) | $100.00 | $1,200.00 |
| OpenAI API — GPT-4o-mini (team assistant) | $0.50 – $2.00 | $6 – $24 |
| Databases, hosting, email, monitoring | $0.00 | $0.00 |
| **Wolfpack Auto (Dealer Platform)** | | |
| All fixed infrastructure | $0.00 | $0.00 |
| Twilio SMS (estimated) | $5 – $15 | $60 – $180 |
| FAL.ai image processing (estimated) | $1 – $5 | $12 – $60 |
| OpenAI embeddings (estimated) | $0 – $2 | $0 – $24 |
| Stripe (transaction fees, pass-through) | Varies | Varies |
| **Grand Total (excl. Stripe pass-through)** | **$107 – $124** | **$1,284 – $1,488** |

**Realistic monthly cost: ~$120/month.**

19 of 23 services run on free tiers. The remaining lines are either fixed (Claude Max, the CTO development tool) or transaction-based (Twilio SMS, FAL.ai, OpenAI embeddings, Stripe) and only incur charges when the platforms are actively generating value.

---

## What Changed vs. the April 6 Report

| Line | April 6 (Claude-only) | April 7 (Hybrid) | Delta |
|---|---|---|---|
| Wolfpack Instinct — team Assistant LLM | $5 – $15 (Claude API) | $0.50 – $2 (GPT-4o-mini) | **−$4.50 to −$13** |
| Wolfpack Instinct — Claude Max (CTO) | $100 | $100 | unchanged |
| Wolfpack Auto — OpenAI embeddings | $0 – $2 | $0 – $2 | unchanged |
| Everything else | unchanged | unchanged | unchanged |
| **Total** | **$111 – $137** | **$107 – $124** | **−$5 to −$15/mo** |

**Annual savings: ~$60 to ~$180.** Today.

---

## Why Hybrid Matters (Beyond Today's Savings)

Today's savings are small. The architectural decision matters for two things this report cannot fully capture yet:

### 1. Wolfpack Auto unit economics at scale

The current $0–2/mo OpenAI line on Wolfpack Auto is **embeddings only**. There are no LLM-powered dealer features in production yet. When those ship (VDP descriptions, customer chat, lead intelligence narratives), the per-dealer cost becomes the binding constraint on the business.

Projected monthly LLM cost at 50 dealers, by vendor strategy:

| Strategy | Approx. monthly cost | Per-dealer |
|---|---|---|
| Claude Opus everywhere | $1,800 – $2,500 | $36 – $50 |
| Claude Sonnet everywhere | $400 – $550 | $8 – $11 |
| GPT-4o everywhere | $300 – $400 | $6 – $8 |
| **Hybrid: GPT-4o-mini bulk + GPT-4o premium** | **$60 – $120** | **$1.20 – $2.40** |

This is the actual reason the architecture decision matters. At one internal dealer it's noise. At 50 paying dealers it is the difference between healthy margins and underwater unit economics.

### 2. Wolfpack Instinct enterprise positioning

For future client deployments of Instinct, the LLM provider can be configured as **Azure OpenAI** instead of OpenAI direct. Same models, same prices. The strategic difference: Azure OpenAI lives inside the customer's Azure / Microsoft 365 tenant — same Entra ID, same compliance boundary, no second vendor on a security review. For clients already on M365 (the majority of enterprise prospects), this collapses the procurement story from "we use a third-party AI vendor" to "your data never leaves your Azure tenant."

This is a sales-cycle asset, not a cost savings.

---

## What's NOT Needed

The following are explicitly **not required** and have zero cost:

- M365 Copilot per-seat licensing (~$30/user/mo) — Instinct provides the team-AI layer ourselves
- Individual Claude or ChatGPT subscriptions for team members — they use the Wolfpack Assistant through Instinct
- Separate chat tools or Slack subscriptions
- Additional Vercel seats (viewers are free)
- Redis / caching layer (built-in caching handles current scale)
- Custom domain SSL certificates (automatic through Vercel)

---

## When Costs Would Increase

| Trigger | What Changes | Added Cost |
|---|---|---|
| Database exceeds 0.5 GB (either platform) | Upgrade Neon to Launch | +$19/mo |
| Over 3,000 emails/month | Upgrade Resend to Pro | +$20/mo |
| Custom email domain (@thewolfpack.agency) | Resend Pro | +$20/mo |
| 1,000+ vehicles in inventory | Elasticsearch for advanced search | +$16–95/mo |
| High site traffic (1,000+ daily) | Vercel Pro + Redis | +$20–30/mo |
| Managed payroll for dealers | Gusto integration | +$40+/mo |
| Wolfpack Auto launches LLM dealer features | OpenAI mini + 4o (per-dealer scaling) | ~$1–2 per dealer/mo |

None of these (except eventual dealer LLM features) are expected at launch or in the near term.

---

## Steps to Go Live

### Wolfpack Instinct
1. Set environment variables in Vercel (API keys, database URLs, **OpenAI API key**, Microsoft Graph credentials, QuickBooks credentials)
2. Run database migrations (one command — includes per-user MS Graph isolation migration shipped April 7)
3. Create production accounts for each team member
4. Each team member connects their own Microsoft 365 account via Settings → Integrations
5. CEO connects QuickBooks Online via Settings → Integrations

### Wolfpack Auto
1. Set environment variables in Vercel (database, Stripe, Resend, Twilio)
2. Run database migrations
3. Create production admin user and first dealer account
4. Import initial vehicle inventory

**Estimated time to production: under 2 hours for both platforms.**

---

*Wolfpack Agency | Confidential | April 7, 2026 | Revision: hybrid LLM model*
