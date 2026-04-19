# Wolfpack Instinct - Infrastructure & Cost Report

**Prepared for:** Hoxsie, CEO - Wolfpack Agency
**Prepared by:** Nick Homyk, CTO
**Date:** April 6, 2026

---

## Executive Summary

Wolfpack Instinct is our team intelligence platform providing AI-powered assistance, knowledge management, reporting, analytics, and internal collaboration for the entire Wolfpack Agency team. This report breaks down every cost required to run Instinct in production.

**Bottom line: $125-135/month ($1,500-1,620/year) to run the entire platform for all 5 team members.**

---

## What the Team Gets

Every team member (Hoxsie, Max, Jorge, Meghan, Nick) gets access to:

- **Wolfpack Assistant** - AI-powered Q&A that learns from every interaction
- **Knowledge Base** - Searchable team knowledge that grows over time
- **Reports** - Branded client reports, proposals, and internal audits
- **Discussions** - Threaded team conversations with resolution tracking
- **Feature Requests** - Submit ideas, vote, track development
- **Journal** - Team activity log and daily context
- **Client Management** - Client profiles and communication tracking
- **Email Templates** - Professional client emails generated instantly
- **Analytics** - Usage insights, team activity, and AI efficiency metrics

---

## Monthly Cost Breakdown

### 1. AI & Development Tools

| Service | What It Does | Plan | Monthly Cost |
|---------|-------------|------|-------------|
| Claude Max | Nick's development tool (IDE, Claude Code, building Instinct) | Max 5x (Personal) | $100.00 |
| Claude API | Powers the Wolfpack Assistant for all 5 team members | Pay-as-you-go | $5.00 - $15.00 |

**AI Subtotal: $105.00 - $115.00/month**

The Claude API cost scales with usage. At current estimates (each team member asking ~20 questions/day), the cost stays under $15/month. The assistant gets smarter over time by caching answers, meaning repeated questions cost nothing.

### 2. Hosting & Deployment

| Service | What It Does | Plan | Monthly Cost |
|---------|-------------|------|-------------|
| Vercel | Hosts the Instinct web application (wolfpack-apex.vercel.app) | Pro (1 seat) | $20.00 |

**Hosting Subtotal: $20.00/month**

All team members access Instinct through the browser. Only the builder (Nick) needs a paid Vercel seat. Dashboard viewers are free.

### 3. Databases & Storage

| Service | What It Does | Plan | Monthly Cost |
|---------|-------------|------|-------------|
| Neon PostgreSQL | Primary database - stores all team data, conversations, knowledge, analytics | Free | $0.00 |
| Qdrant Cloud | Vector database - powers smart search and knowledge matching | Free | $0.00 |
| Neo4j AuraDB | Graph database - maps relationships between team knowledge | Free | $0.00 |

**Database Subtotal: $0.00/month**

All three databases offer production-ready free tiers that comfortably handle our team size. Detailed capacity:

- **Neon:** 0.5 GB storage, 100 compute-hours/month. A team of 5 generating knowledge entries, discussions, and reports will use a fraction of this.
- **Qdrant:** 1 GB RAM, 4 GB disk. Stores ~500,000 knowledge vectors. We won't approach this limit.
- **Neo4j:** 50,000 nodes, 175,000 relationships. More than enough to map all team knowledge connections.

### 4. Email & Monitoring

| Service | What It Does | Plan | Monthly Cost |
|---------|-------------|------|-------------|
| Resend | Sends email notifications and client communications | Free (3,000 emails/month) | $0.00 |
| Sentry | Error monitoring and crash reporting | Free | $0.00 |

**Email & Monitoring Subtotal: $0.00/month**

---

## Monthly & Annual Totals

| Line Item | Monthly | Annual |
|-----------|---------|--------|
| Claude Max (Nick's development) | $100.00 | $1,200.00 |
| Claude API (Team assistant) | $5.00 - $15.00 | $60.00 - $180.00 |
| Vercel Pro (Hosting) | $20.00 | $240.00 |
| Neon PostgreSQL | $0.00 | $0.00 |
| Qdrant Cloud | $0.00 | $0.00 |
| Neo4j AuraDB | $0.00 | $0.00 |
| Resend Email | $0.00 | $0.00 |
| Sentry Monitoring | $0.00 | $0.00 |
| | | |
| **Total** | **$125.00 - $135.00** | **$1,500.00 - $1,620.00** |

**Cost per team member: ~$25-27/month**

---

## What's NOT Needed

The following are explicitly **not required** and have zero cost:

- Individual Claude subscriptions for team members (they use the assistant through Instinct)
- Separate chat tools or Slack subscriptions
- Additional Vercel seats (viewers are free)
- Redis/caching layer (built-in caching handles current scale)
- Custom domain SSL certificates (automatic through Vercel)

---

## Future Scaling Costs (Not Needed Now)

If the team grows significantly or usage increases dramatically, here are the thresholds:

| Trigger | What Changes | Added Cost |
|---------|-------------|------------|
| Database exceeds 0.5 GB | Upgrade Neon to Launch plan | +$19/month |
| Over 3,000 emails/month | Upgrade Resend to Pro | +$20/month |
| Need custom email domain (e.g., @thewolfpack.agency) | Resend Pro | +$20/month |
| Heavy AI usage (100+ questions/day across team) | API costs scale automatically | ~$30-50/month |
| Additional builders needing Vercel access | Add Vercel Pro seats | +$20/month per seat |

None of these are expected in the near term with a 5-person team.

---

## Steps to Go Live

All code is built and tested. Going live requires only configuration:

1. Set environment variables in Vercel dashboard (API keys, database URLs)
2. Run database migrations (one command)
3. Create production user accounts for each team member

Estimated time to production: **under 1 hour.**

---

## Summary

Wolfpack Instinct gives the entire team an AI-powered workspace with knowledge management, reporting, analytics, and collaboration tools for approximately **$125/month**. Every team interaction makes the system smarter. The platform is built, tested (359 passing tests), and ready to deploy.

---

*Report generated April 6, 2026 | Wolfpack Agency*
