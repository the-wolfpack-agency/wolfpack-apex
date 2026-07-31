/**
 * seed-engineering-wiki.ts: idempotent seed of the OGIAM Engineering wiki
 * (/engineering). Upserts the starter page tree on `slug`, so re-running updates
 * content in place. Pages are plain-language and grounded in the codebase; edit
 * here (or in-app once the editor lands) and re-run.
 *
 * Usage: npm run engineering:seed  (needs DATABASE_URL)
 */

import { upsertPage } from "@/lib/engineering";

interface Seed {
  slug: string;
  parentSlug: string | null;
  title: string;
  position: number;
  body: string;
}

export const PAGES: Seed[] = [
  {
    slug: "overview",
    parentSlug: null,
    position: 0,
    title: "Overview",
    body: `## What this wiki is
The OGIAM Engineering wiki is the single, plain-language explanation of how the Wolfpack systems are built and run. It is written for everyone on the team, not just engineers.

Use the pages on the left to explore what the agents can do, how a change goes from idea to production, the tools and languages we use, the rules that keep our systems reliable, and how we cover compliance and testing.

## The short version
- We build AI-powered operating systems for the agency and its clients.
- An enforced gate sits between any AI and our code and data, so the AI does the work but cannot cause harm.
- Every change is tested at multiple layers and verified on the live site before it reaches a client.

## See the products
Our public, client-facing site for all of these products is [ogiam.com](https://ogiam.com). It is the marketing home where clients and prospects see what we offer.

## How to read it
Each page is short and jargon-light. Pages nest into sections, and the wiki grows over time as we add pages. If something here is unclear, that is a gap worth filling: tell the team and we will add a page.`,
  },
  {
    slug: "agents",
    parentSlug: null,
    position: 1,
    title: "Agents",
    body: `## Our agents
Agents are AI actors that do real work inside Instinct and connected systems, on your behalf, under a deterministic gate that decides, executes, and audits every action. They are the safe way to put an LLM to work: full capability, no unchecked risk.

See **What the agents can do** for the exact, code-grounded list of their abilities.`,
  },
  {
    slug: "agent-capabilities",
    parentSlug: "agents",
    position: 0,
    title: "What the agents can do",
    body: `This is the ground truth of what the agents can actually do, based on the code. They inherit a 60-tool vocabulary through the shared dispatcher and act on it as their owner, gated and audited by OGIAM. In practice they can autonomously:

## Communicate and coordinate
- Send and manage **email**, **Teams messages**, and threads.
- Run the **calendar and meetings**: check availability, book, and prepare for a meeting.
- Manage **tasks, goals, and OKRs**, and log time.

## Operate any connected system
- Full **CRM / external-record CRUD**: create, get, update, search, filter, and aggregate records.
- Works across **5 connector auth types** (NextAuth, OAuth, OAuth-password, static bearer, username / password) via the REST connector and vendor presets.
- This is the "drop into a client's system" reach.

## Finance
- Read **financial metrics**.
- Scan **invoices and receipts**.
- Run **cross-tool insights** across systems.

## Knowledge
- Search and ingest the **Brain** (our knowledge store).
- Scan **HR documents**.
- Save **team facts** for reuse.

## Dev and ops signals
- Query **GitHub** issues and pull requests.
- Check **Vercel** deployments and recent workflow runs.

## Orchestrate and stay safe
- **Delegate** to other agents and run learned procedures.
- **Escalate** gate-blocks to a human.
- Operate under a per-capability **enforce / monitor** posture.

## How the gate keeps this safe
- Every action is **proposed**, then a deterministic policy engine **decides** (allow, escalate, or block), **executes**, and **records** it to a hash-chained, tamper-evident ledger.
- Agents act with **short-lived, scope-limited tokens** as their owner, never elevated.
- **High-risk or destructive actions** are intercepted and escalated to a human.`,
  },
  {
    slug: "how-we-build",
    parentSlug: null,
    position: 2,
    title: "How we build",
    body: `## How we build
Every change follows the same disciplined path from idea to production, with checks at each step so problems are caught before a client sees them.

The sub-pages cover the deployment workflow, how we test, and the core tenets that keep our systems reliable.`,
  },
  {
    slug: "deployment-workflow",
    parentSlug: "how-we-build",
    position: 0,
    title: "Deployment workflow",
    body: `## From idea to production
1. Understand and baseline: read the code and know the before and after of the feature being changed.
2. Branch off the deploy branch.
3. Make the change.
4. Verify locally: one shared script runs lint, type-check, tests, and a production build (the same checks CI runs, so local green means CI green).
5. Commit, push, and open a pull request.
6. CI runs the full gate on the pull request. This is the real gate, not the local run.
7. A human reviews and merges.
8. Deploy: automatic on merge for most systems.
9. Verify on the live URL: confirm the new version is serving and the page renders correctly, including on mobile.
10. Record what was learned.

## Why it is safe
Nothing reaches production without passing the same automated checks twice (local and CI), a human approval, and a post-deploy verification. When the agent write-loop lands, agents follow this exact path under the gate, so it is at least as safe as a person doing it by hand.

## Keeping the team informed
Release notes are generated from the actual commits, not written by hand: the changes since the last release are grouped into plain-English entries (what changed and how to use it), published to the Releases page, and emailed to the team. It runs on demand with one click, so everyone hears about a new feature without anyone stopping to write an announcement.`,
  },
  {
    slug: "testing-and-quality",
    parentSlug: "how-we-build",
    position: 1,
    title: "Testing and quality",
    body: `## How a change is verified
Every change runs the pipeline shown above: a sequence of automated gates, from a local check to a live-site verification. A change only reaches production by passing all of them. A failure at any gate stops it and returns it to its author, so bad code cannot reach a client. This is what AgenticQA does: deterministic tooling verifies AI (and human) output before it ships.

## The test layers
We test at every layer, because failures hide in the seams between them.

- **Contract tests**: every API asserts the real outcomes (200, 401, 403, 400), not just "did not crash".
- **Database tests**: migrations are idempotent, access rules are enforced, and audit hash-chains verify.
- **Unit tests**: the logic in each module is exercised directly.
- **UI tests**: components render the correct state, with no broken widgets.
- **End-to-end tests through the UI**: a real browser drives the deployed app and asserts pages load, there are no security-policy violations, and the key content actually renders.
- **Multi-device checks**: pages are verified across phone, tablet, and desktop widths so a layout does not break on a screen size we did not consider.

## Pass or fail, at every gate
| Gate | What it verifies | On pass | On fail |
| --- | --- | --- | --- |
| Local verify | Lint, types, tests, build | Open a pull request | Fix before pushing |
| CI gate | The full suite on a clean machine | Continue to review | Merge is blocked |
| Security & dependencies | Static scan + dependency audit | Continue to review | Merge is blocked |
| Human review | A person approves the change | Merge and deploy | Returned to author |
| Live verification | Real URL, including mobile | Done | Roll back and fix |

The decision at each gate is made by deterministic tooling, not opinion, so the same change always gets the same verdict.

## Verifying across devices
Most of the bugs that used to reach the team were layout problems on a screen size we did not check: content squished or buried on a phone, a page scrolling sideways, an element running off the edge. We now verify every important page across **phone, tablet, and desktop** widths automatically. The check loads the real page at each size and flags horizontal overflow, elements past the edge, content that is missing or has collapsed to nothing, and console or security-policy errors. A high-severity finding fails the check, so a broken mobile layout is caught before it ships instead of after a client sees it.`,
  },
  {
    slug: "core-tenets",
    parentSlug: "how-we-build",
    position: 2,
    title: "Core tenets and rules",
    body: `## The rules that lead to our great systems
1. **The gate is the moat.** An enforced, deterministic gate sits between any AI and our code and data. The AI proposes; the gate decides, executes, and audits. Full LLM power, no unchecked risk.
2. **Deterministic first.** Use rules and tooling wherever possible; reach for AI only for genuinely new work, then bake that work into deterministic tooling for every run after.
3. **Test at every layer.** A feature is not done until it is validated at the contract, database, UI, and end-to-end levels, and no existing behavior regresses.
4. **Reuse, do not duplicate.** Extend existing code and tooling; extract shared helpers instead of re-implementing.
5. **Tie everything into the learning mechanism.** Every durable action emits an analytics event and, where relevant, an audit-ledger entry, so no data is lost and the system gets smarter over time.
6. **Verify on the real thing.** A change is done when it works on the deployed URL, not just in a local test.
7. **No unchecked risk.** External integrations return typed errors instead of throwing; secrets never live in code; least privilege everywhere.`,
  },
  {
    slug: "single-source-of-truth",
    parentSlug: null,
    position: 3,
    title: "Single source of truth",
    body: `## Documentation that cannot drift
Our reference material is generated from the actual code and data, not written and maintained separately alongside it. The code is the single source of truth; the documentation derives from it. If the two ever disagree, the code is right by definition and the document is the bug to fix.

## Why this keeps us honest and accurate
- Hand-maintained docs drift. The system changes, the doc does not, and it quietly becomes fiction that misleads the next person.
- Deriving docs from the source closes that gap: what you read here reflects what the system actually does today, not what someone intended months ago.

## How we do it
- The **Releases** timeline is built from real repository history (creation dates, lines of code, and the release reports we ship), not typed by hand.
- **What the agents can do** is grounded in the code's tool registry, the true tool vocabulary, not an aspirational wish list.
- **Capabilities, analytics events, and the API surface** each have one canonical definition in code that everything else references. Duplicating one is treated as a bug.
- This wiki is written against the codebase and re-generated as the system evolves.

## The rule
If a fact matters, it has exactly one home, in code or data, and every view of it points back to that home. We reference, we do not duplicate.`,
  },
  {
    slug: "our-stack",
    parentSlug: null,
    position: 4,
    title: "Our stack",
    body: `## What we build with
Our systems share a common foundation, so a pattern proven in one product carries to the next. The sub-pages cover the languages and stack, the tools we use, and how we get the most out of AI efficiently.`,
  },
  {
    slug: "languages-and-stack",
    parentSlug: "our-stack",
    position: 0,
    title: "Languages and stack",
    body: `## Languages
- **TypeScript** everywhere (application code, tools, and tests), for one type-safe language across the stack.
- **SQL** for data (Postgres).
- **Python** for parts of the AI governance and scanning tooling.

## Core technologies
- **Next.js** (App Router) on **Vercel**: the web application and its APIs.
- **Postgres** (Neon): the source-of-truth database.
- A **triple-write** pattern (Postgres + a vector store + a graph store) for durable, learnable entities.
- **Microsoft Graph**: the enterprise integration backbone (mail, calendar, files, Teams).
- **Redis, Elasticsearch, and S3** where a product needs cache, search, or media.`,
  },
  {
    slug: "tools-and-technologies",
    parentSlug: "our-stack",
    position: 1,
    title: "Tools we use",
    body: `## Build and verify
- One **shared verify script** (lint, type-check, tests, build) run identically locally and in CI.
- **GitHub Actions** for CI gates; [**GitHub**](https://github.com/the-wolfpack-agency) for source and pull requests.
- [**Vercel**](https://vercel.com/nhomyks-projects) for hosting and deploys.
- **Playwright** for end-to-end and multi-device browser testing.
- **Jest** for unit, contract, and UI tests.

## AI and governance
- The **OGIAM gate**: a deterministic policy engine, a hash-chained audit ledger, and scope-limited agent tokens.
- **AgenticQA**: the trust-and-safety layer for AI systems (attack hardening, decision traceability, compliance checks).
- An in-house **AI gateway** that routes each task to the cheapest capable model.`,
  },
  {
    slug: "ai-efficiency",
    parentSlug: "our-stack",
    position: 2,
    title: "AI efficiency focus",
    body: `## Getting the most from AI, efficiently
- **Deterministic first.** We do not spend AI tokens on work that rules or existing tooling can do. AI is reserved for genuinely new reasoning, then baked into deterministic tooling so the next run is free.
- **Ground answers in our own data first** (the Brain, Microsoft 365) before reaching for a model, so answers are accurate and cheap.
- **Cost-routed models.** Each task goes to the cheapest model that can do it well.
- **Measured and audited.** Every AI action is measured (analytics) and audited (ledger), so we can see where AI adds value and where it does not.`,
  },
  {
    slug: "compliance-and-security",
    parentSlug: null,
    position: 5,
    title: "Compliance and security",
    body: `## Compliance and security
We build for enterprise trust from day one.

## Compliances covered
- **HIPAA, GDPR, and the EU AI Act**: AgenticQA maps AI systems against these regulations and flags gaps.
- **Forensic traceability**: a hash-chained, tamper-evident audit ledger records security-relevant actions.
- **Prompt-injection detection** and **model-regression testing** for AI systems.

## Security posture
- **Least-privilege** access, enforced by a capability model; agents act with short-lived, scope-limited tokens.
- **Secrets** live in environment configuration, never in code.
- **Row-level data isolation** between tenants.
- **Crypto-agile** and quantum-migration-ready signing.
- A public security-posture page documents the current stance.`,
  },
];

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error("[seed-engineering] DATABASE_URL not set.");
    process.exit(1);
  }
  let n = 0;
  for (const p of PAGES) {
    await upsertPage({
      slug: p.slug,
      parentSlug: p.parentSlug,
      title: p.title,
      body: p.body,
      position: p.position,
      published: true,
      createdBy: "seed",
    });
    n++;
  }
  console.log(`[seed-engineering] upserted ${n} page(s).`);
}

// Only run when invoked directly (npm run engineering:seed), not when this
// module is imported for its exported PAGES (e.g. by a verification harness).
if (process.argv[1]?.includes("seed-engineering-wiki")) {
  main().catch((err) => {
    console.error("[seed-engineering] failed:", err);
    process.exit(1);
  });
}
