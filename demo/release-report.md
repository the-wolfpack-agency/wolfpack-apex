# Wolfpack Apex — Release Report
**Prepared by:** AgenticQA / Claude Code
**Date:** April 5, 2026
**Built in:** 1 session
**Repo:** the-wolfpack-agency/wolfpack-apex
**Deployed:** https://wolfpack-apex.vercel.app

---

## Executive Summary

Wolfpack Apex is the team intelligence platform for Wolfpack Agency. It connects team members, AI, and the codebase into a single system that compounds knowledge over time. Every interaction is tracked, cached, and indexed so the platform gets smarter the longer the team uses it.

The core principle is zero-token-first: questions are answered from cached knowledge, codebase analysis, or analytics data before ever calling AI. When AI is needed, the response is cached so the same question never costs tokens twice.

---

## Platform Architecture

| Component | Technology | Purpose |
|---|---|---|
| Framework | Next.js 15 (App Router) | Full-stack web application |
| Hosting | Vercel | Production deployment |
| Primary DB | PostgreSQL (Neon) | Structured data, analytics events, all CRUD |
| Vector Store | Qdrant | Semantic search for knowledge entries |
| Graph DB | Neo4j | Knowledge graph, collaboration patterns |
| Auth | JWT + bcrypt | Role-based (cto/dev/sales/ops) |
| Styling | Tailwind CSS | Wolfpack Agency branding |
| Fonts | Lexend Peta + Ubuntu Mono | Brand fonts |
| Testing | Jest + ts-jest | 304 tests across 14 suites |
| AI (fallback) | Anthropic API | Custom reports + assistant (cached) |

---

## Features

### Apex Assistant
Zero-token priority chain: knowledge cache, codebase search, analytics data, then AI as last resort. Chat interface with source badges showing where each answer came from. Thumbs up/down rating feeds back into knowledge quality. Every AI response cached for free future retrieval.

### Knowledge Base
Cache-first Q&A. Questions searched via pg_trgm trigram similarity. Answers rated 1-5 stars. Popular unanswered questions surface as documentation gaps. View count tracks demand.

### Team Journals
Auto-populated from user actions (questions asked, docs generated, features submitted, discussions participated in). Optional manual notes. Mood tracking. Date navigation.

### Document Generation (Zero-Token)
- API docs from TypeScript/Python code parsing
- Release notes from git log parsing
- Feature docs from database records
- All zero-token: pure code analysis, no AI

### Report Generator
7 branded templates: Platform Capabilities, Technical Architecture, Client Proposal, Implementation Plan, Product Audit, Monthly Review, Create Your Own.

Create Your Own accepts freeform prompts and generates custom reports via AI. All content auto-cleaned of AI artifacts (em dashes, AI-tell words). Reports saveable as reusable templates.

### Feature Requests
Submit with automated zero-token analysis: complexity estimation (keyword patterns), cost calculation ($150/hr), risk detection, similar feature search. Automation suggestions calculate time savings and ROI.

### Discussions
Threaded conversations with categories (product, client, engineering, process, general). Role-gated pinning (dev+ only). Resolution tracking.

### Codebase Browser
Non-technical team members can browse the wolfpack-auto file tree, search code, view stats (files, routes, tests, migrations), and get plain-English file explanations. All zero-token.

### Client Email Templates
4 templates (proposal, follow-up, status update, onboarding) with variable substitution. Copy to clipboard.

### Client Profiles
CRUD with document linking. Industry tags. Contact management.

### Analytics Dashboard
- AI efficiency trend (zero-token % over time)
- Most asked questions (knowledge gaps)
- Team activity breakdown
- Feature request pipeline funnel
- Automation potential (manual tasks with ROI)
- Document generation stats

---

## Data Flow

```
User action
  → trackEvent() → PostgreSQL (primary)
                 → Qdrant (vector embeddings)
                 → Neo4j (knowledge graph)
  → 7 learning views aggregate insights
  → Knowledge cache grows with every interaction
  → AI efficiency improves as cache fills
```

## Learning Views

| View | Purpose |
|---|---|
| v_knowledge_gaps | Questions asked 2+ times with low/no rating |
| v_ai_efficiency | Daily zero-token vs AI call ratio |
| v_team_activity | Per-member action counts by category |
| v_knowledge_quality | Answer quality by source (cached/ai/human) |
| v_feature_pipeline | Feature request funnel (submitted → completed) |
| v_question_to_doc_pipeline | Questions that led to doc generation |
| v_automation_opportunities | Manual tasks ranked by ROI |
| v_team_expertise | Who knows what (tag-based expertise map) |
| v_discussion_velocity | Average time to thread resolution |
| v_product_knowledge_demand | Which products generate the most questions |

---

## Roles

| Role | Access | Use Case |
|---|---|---|
| **CTO** | Full access, all pages, approve features, pin discussions, team journals | Architecture decisions, oversight |
| **Dev** | Code, docs, prototypes, features, discussions, pin threads | Implementation, technical Q&A |
| **Sales** | Clients, proposals, reports, emails, features, discussions | Client-facing docs, proposals |
| **Ops** | Journals, processes, discussions, automation suggestions | Operations, process improvement |

---

## Security

- JWT auth with bcrypt password hashing
- Role hierarchy enforcement (CTO > Dev > Ops > Sales)
- APEX_JWT_SECRET throws error if unset in production
- Path traversal prevention on codebase file access
- AI artifact cleanup on all generated content
- No AI provider names in UI
- No secrets in repo (lesson learned from GitGuardian incident)

---

## Test Coverage

304 tests across 14 suites:

| Suite | Tests | Coverage |
|---|---|---|
| Knowledge base | 12 | Cache hit/miss, save, rate, search, gaps |
| Team journals | 10 | Create, update, auto-context, history |
| Document generator | 13 | TS/Python parsing, release notes, feature docs |
| Feature requests | 22 | Submit, analyze, vote, status, pipeline |
| Discussions | 16 | Create, reply, resolve, pin (role check), filters |
| Clients | 14 | CRUD, doc linking, shadow mode |
| Dashboard + Auth | 14 | Stats, JWT, role hierarchy |
| Role workflows | 61 | CTO/Dev/Sales/Ops daily simulations |
| Triple-write | 30 | PG/Qdrant/Neo4j independence, health checks |
| Codebase connector | 20 | Structure, search, stats, explain, path traversal |
| Email generator | 16 | All templates, variables, errors |
| Report templates | 36 | All 7 templates, sections, HTML rendering |
| Claude reports | 8 | Cache, fallback, tracking |
| Assistant | 16 | Priority chain, conversation, rating |
| Assistant data flow | 52 | Full pipeline: prompt → PG → Qdrant → Neo4j → response → analytics |

---

## Persistent Assistant Memory

The assistant maintains 4 layers of persistent memory so team members never come back to a clueless agent:

| Layer | Store | What It Remembers |
|---|---|---|
| **User Memory** | apex_user_memory (PG) | Role, preferences, expertise topics, past instructions |
| **Conversation Memory** | apex_conversations + apex_messages (PG) | Full chat history, auto-resume, summaries |
| **Organizational Memory** | apex_knowledge (PG) + Qdrant vectors | Cached Q&A, docs, codebase context |
| **Analytics Memory** | apex_events (PG) + learning views | Response quality, gaps, efficiency trends |

### Modular Chat Component

`<ApexChat />` is standalone and embeddable on any page:
- Self-contained auth (reads JWT from localStorage)
- Page context injected automatically (assistant knows WHERE the user is asking)
- Inline mode (full page) or floating mode (bottom-right bubble)
- Source badges, rating, conversation history sidebar
- Triple-write on every interaction (PG + Qdrant + Neo4j)

### AI Integration

- Uses Wolfpack Agency organization Claude API key
- Zero-token priority: knowledge cache → codebase → analytics → AI (last resort)
- Every AI response cached in knowledge base for free future retrieval
- All output cleaned of AI artifacts (em dashes, AI-tell words)
- No AI provider branding in UI ("Apex Assistant" only)

---

## Build Metrics

| Metric | Value |
|---|---|
| Total pages | 13 |
| API routes | 15+ |
| Database tables | 13 |
| Learning views | 13 |
| Tests | 390 |
| Test suites | 15 |
| TypeScript errors | 0 |
| Report templates | 7 (6 built-in + Create Your Own) |
| Email templates | 4 |
| Team roles | 4 (cto, dev, sales, ops) |
| Data flow tests | 52 (verify data lands in all 3 stores) |

---

*Built by Wolfpack Agency Engineering. Powered by AgenticQA.*
