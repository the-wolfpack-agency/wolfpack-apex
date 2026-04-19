# 🐺 Wolfpack Instinct

**Team intelligence platform for Wolfpack Agency.**

Instinct is the central brain connecting the Wolfpack team, AI, and codebase. It compounds knowledge from every team interaction — questions, documents, discussions, feature requests — making the platform smarter the longer the team uses it.

## What It Does

- **Knowledge Base** — Ask questions about the codebase or products. Answers are cached so the same question is never asked twice (zero AI cost on repeat queries).
- **Team Journals** — Daily context auto-generated from your actions, questions, and calendar. Never lose track of what happened.
- **Doc Generation** — Generate API docs, release notes, and client proposals directly from the codebase. Zero AI tokens — pure code analysis.
- **Feature Requests** — Submit ideas with automated complexity analysis, cost estimates, and competitive comparisons.
- **Discussions** — Collaborative threads organized by product, client, engineering, or process.
- **Client Context** — Centralized client profiles with linked documents, proposals, and communication history.
- **Prototype Sandbox** — Spin up isolated prototypes that auto-deploy to test URLs.

## Architecture

- **Zero-token-first** — AI is only used when code analysis can't answer the question. Every answer is cached for next time.
- **Compounding knowledge** — Every interaction is tracked, indexed, and rated. The 50th time someone asks about a feature, the answer is instant.
- **Role-based views** — CTO, Dev, Sales, Ops each see what's useful for their role. Same data, different perspectives.
- **Learning loop** — Popular unanswered questions surface as documentation gaps. AI efficiency is tracked daily.

## Access

Wolfpack Instinct is a hosted web application. Team members access it via browser — no local setup required.

**Production:** Deployed on Vercel (URL provided by admin)

**Demo credentials (development only):**
- CTO: `cto@wolfpack.dev` / `apex`
- Dev: `dev@wolfpack.dev` / `apex`
- Sales: `sales@wolfpack.dev` / `apex`
- Ops: `ops@wolfpack.dev` / `apex`

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | Next.js 15 (App Router) |
| Hosting | Vercel |
| Database | PostgreSQL (Neon) |
| Vector Store | Qdrant (knowledge embeddings) |
| Auth | JWT + bcrypt (role-based) |
| Styling | Tailwind CSS + Wolfpack Agency branding |
| Fonts | Lexend Peta + Ubuntu Mono |
| Testing | Jest + ts-jest |

## For Developers

```bash
# Run tests
npx jest --no-coverage

# Apply database migrations
npx tsx src/db/migrate.ts

# Deploy to Vercel
npx vercel deploy --prod --yes
```

## Environment Variables

Set these in the Vercel dashboard (Settings → Environment Variables):

```
DATABASE_URL=           # Neon PostgreSQL connection string
APEX_JWT_SECRET=        # Generate with: openssl rand -base64 32
QDRANT_URL=             # Qdrant Cloud endpoint (optional)
QDRANT_API_KEY=         # Qdrant API key (optional)
```
