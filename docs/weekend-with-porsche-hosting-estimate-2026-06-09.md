# A Weekend with Porsche — Tech Hosting Cost Estimate

**Date:** 2026-06-09
**Prepared by:** The Wolfpack Agency (OGIAM / Instinct platform)
**Scope:** Cost to **deploy and run the digital tool** — compute, database, vector/graph stores, transactional email, CDN/bandwidth, error monitoring. Domains are already owned (not a line item). Program/experience costs are tracked separately and excluded here.

---

## 1. What's deployed

The Instinct-built surface for the program:

- **Public responder** `/s/<slug>` — guest/dealer feedback surveys (themed per brand), served per visit.
- **QR codes + redirect** `/q/<slug>` — printed-asset short links with scan analytics.
- **Admin builder + analytics** `/surveys`, `/qr` — internal survey/QR management + funnel insights.
- **Data + learning** — responses, views, scans, events → Postgres (source of truth), fanned out to vector + graph stores.

Stack: **Next.js on Vercel** · **Neon** Postgres · **Qdrant** (vectors) · **Neo4j** (graph) · **Resend** (email) · **Sentry** (errors). TLS + CDN included via Vercel.

---

## 2. Compute & storage footprint (the cost driver)

Invitation-only, ~15 pilot centers → low volume. 90-day pilot estimates (generous):

| Resource | Volume | Footprint |
|---|---|---|
| Postgres — responses + views + scans + events | ~70k rows | **< 100 MB** (< 1 GB at 10× headroom) |
| Vector store (free-text embeddings) | ~4k vectors (1536-dim) | ~25 MB |
| Graph (nodes/edges) | ~10k | a few MB |
| Compute (serverless function calls) | ~10k–50k / mo, sub-300 ms each | within smallest tier |
| Bandwidth (pages, QR SVGs) | a few GB / mo | within included |

Takeaway: the tool serves forms, redirects, and light analytics — **cost is fixed-subscription-bound, not usage-bound.**

---

## 3. Cost scenarios

### A. Incremental on existing Instinct infra — recommended for pilot
Runs on the Vercel project + Neon + Qdrant + Neo4j + Resend already paid for Instinct. The added ~100 MB of data and tens of thousands of light requests/month fit inside existing capacity.

**≈ $0 / mo incremental** (no net-new infrastructure; domains owned).

### B. Dedicated / isolated stack (only if Porsche requires data isolation)

| Service | Tier | $/mo |
|---|---|---|
| Vercel | Pro (compute + bandwidth) | 20 |
| Neon Postgres | Launch (~10 GB) | 19 |
| Qdrant | Free 1 GB (fits) → managed if isolation required | 0–25 |
| Neo4j AuraDB | Free → Professional if isolation required | 0–65 |
| Resend (email) | Pro (50k sends) | 20 |
| Sentry | Developer free → Team | 0–26 |
| **Dedicated pilot total** | | **≈ $60–175 / mo** |

Planning mid-point: **~$120 / mo (~$1,440 / yr).**

### C. National rollout (~190 US centers, standing platform)

| Service | Tier | $/mo |
|---|---|---|
| Vercel | Pro + usage | 50–150 |
| Neon Postgres | Scale | ~69 |
| Qdrant | Standard | 25–50 |
| Neo4j AuraDB | Professional | ~65 |
| Resend | Pro/Scale | 20–90 |
| Sentry | Team | ~26 |
| **Rollout total** | | **≈ $250–450 / mo (~$3k–5.4k / yr)** |

---

## 4. Azure & AI (variable — small when built sensibly)

**Today:** the deployed tool makes **zero AI calls**, so **AI cost = $0**. Hosting is Vercel/Neon/Qdrant/Neo4j — **no Azure compute or DB**. The only Azure product in play is **Azure OpenAI**, and only *if* the microsite adds AI personalization (generated invitation/follow-up copy, the "Curated Journey Creator," thematic analysis of feedback).

**How we'd build it:** GPT‑4o‑mini by default (≈15× cheaper, plenty for copy/summaries), GPT‑4o reserved for a few high‑value moments, generated artifacts cached, all behind a hard Azure budget cap. On that basis the realiztic per‑experience AI cost is **~$0.05–0.15**.

### Realiztic monthly AI cost
| Volume | Realiztic AI cost |
|---|---|
| Pilot (~120 experiences/mo) | ~$10–20/mo |
| National, realiztic steady state (~1,000–1,500 exp/mo) | ~$100–200/mo |

Embeddings (text‑embedding‑3) are negligible (a few dollars even at millions of tokens).

> *Uncapped ceiling (not budgeted): all‑GPT‑4o + viral, no controls could in theory reach ~$35k/mo. The Azure budget cap exists precisely to make that impossible — it is not a realiztic figure.*

---

## 5. Bottom line (realiztic)

| Phase | Hosting | AI (controlled) | All‑in / mo |
|---|---|---|---|
| **Pilot — incremental on existing infra** | ~$0 | ~$10–20 | **~$15–30** |
| **Pilot — dedicated/isolated stack** | ~$120 | ~$10–40 | **~$130–160** |
| **National rollout — steady state** | ~$300 | ~$100–200 | **~$400–500 (~$5–6k/yr)** |

Infrastructure is cheap and predictable at every scale; AI is the only variable, and stays in the low hundreds/month with mini‑by‑default + a budget cap.

---

## 6. Budget line item (single, all‑inclusive)

One consolidated line covering every technical aspect of the project — compute, database + storage, vector + graph stores, transactional email, monitoring, and budget‑capped AI:

| ITEM | DESCRIPTION | BUDGET QTY. | TYPE | RATE | BUDGET |
|---|---|---|---|---|---|
| Hosting Fees | All project hosting & infrastructure — Vercel (compute/CDN), Neon Postgres, Qdrant + Neo4j, Sentry monitoring, and Azure OpenAI (AI personalization, mini‑default, hard budget‑capped). | 1.00 | Monthly | $300.00 | $300.00 |

**$300.00 / mo all‑in** (≈ **$3,600/yr**) — a realiztic, safe figure with headroom. For reference: the pilot runs much lower (~$30/mo incremental on existing infra); $300/mo comfortably covers a dedicated stack plus capped AI through national scale.
