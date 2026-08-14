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
    slug: "design-conformance",
    parentSlug: "how-we-build",
    position: 3,
    title: "Design conformance",
    body: `## Does the build match the design
A converted wireframe used to be checked by eye, which is how a header six
pixels too tall, a hero sixty-three pixels short and a heading nineteen pixels
small all shipped as "matching the design". Each one cost a review round to
notice.

Now both pages are measured. Spec-diff loads the prototype and the built page at
the same window sizes, records the position, size and type of every piece of
text, and reports what differs and by how much.

Two details that matter more than they look:

- **Window height is part of the comparison.** A hero sized as a percentage of
  the screen matches at one height and not another, so comparing two differently
  sized windows produces a bug report about a difference that does not exist.
- **The typeface is checked by measuring it, not by reading its name.** Two
  builds can both claim the same font while shipping different cuts, which
  silently rewraps every paragraph. Glyph width does not lie.

A comparison where nothing matched is reported as unmeasured, never as perfect.
Zero differences out of zero comparisons is a broken check wearing a passing
result.`,
  },
  {
    slug: "acceptance-criteria",
    parentSlug: "how-we-build",
    position: 4,
    title: "Acceptance criteria",
    body: `## What "done" means, written down before it is built
A requirement written as prose produces a different build depending on who reads
it, and every correction arrives as another round of description. So the
requirement is not prose. It is a set of fields with validated ranges: the
prototype to match, the pages that must load, the words that must appear, how
much pixel drift is tolerated, whether the typeface must match.

Every deploy is then checked against those fields on the live URL, and the
result is kept whether it passed or not.

The rule that shapes everything else: **a check that could not run is a failure,
not a pass.** A browser that would not start, a prototype that was unreachable,
a page that timed out. All of these are recorded as "could not be checked", and
that is not a green build. The alternative is a tick that means "we did not
look", which is the one outcome worse than a red one.`,
  },
  {
    slug: "model-router",
    parentSlug: "agents",
    position: 3,
    title: "The model router, and how it keeps agents honest",
    body: `## Why there is a router at all
Every AI feature has to pick a model before it can do anything. If each feature picks its own, three things follow: the same work costs different amounts depending on which feature does it, nobody can say what the platform spends, and swapping a model means editing every place that named one.

The router is the single place that choice happens. A feature says what it needs, meaning a capability tier and, where it can, a rough size, and the router returns a specific model and a recorded reason.

## What a client gets from it
A client can plug in their own model, or use ours. Either way the request goes through the same gate.

That is the point. Our safety controls only mean something if they hold for a model we did not build and cannot inspect. A client's own model running through the same containment, the same egress allowlist and the same audit trail is how the claim stays tested rather than asserted.

## Capability tier and cost posture are two different questions
- **Capability tier**: how much the task actually needs, meaning small, large, or reasoning.
- **Cost posture**: how much you are willing to pay for it, meaning cheap, standard, or premium.

Keeping them apart matters. A cheap posture cannot silently downgrade a task that genuinely needs a capable model, and a premium posture does not spend more on work that a small model does perfectly well.

## Available does not mean working
The router page lists which models the platform can reach. Until recently that list meant one thing only: the environment variables are filled in. A deployment name with a typo, a deleted deployment, a rotated key and a working model all looked identical, every one of them green.

**Test each model** on the router page settles it. It sends a one-token request to every configured model and reports which ones answered. A rate limit counts as answering, because it proves the model is there. The provider's response is never shown back, since a rejection message can echo the key that was rejected.

Run it after a deployment, after a key rotation, and before a client demo. From a terminal it is \`npm run models:probe\`, which exits non-zero when a model the list shows as ready did not answer, so a scheduled job can watch it.

## How the router and the agents fit together
They are two halves of the same guarantee, and neither is worth much alone.

- The **agents** decide what to do. The gate decides whether they may, executes it, and records it.
- The **router** decides which model does the thinking, at what capability and what price.

An agent with no router is a fixed bet on one vendor: no cost control, no way to compare models, and a migration project the day that vendor changes its terms. A router with no gate is a cheaper way to run unchecked code.

Together they answer the question a client actually asks before adopting AI: *what stops this from doing something we cannot undo, and what stops it from costing whatever it likes?* The gate answers the first. The router answers the second. Every decision from both is recorded, so the answer is evidence rather than a promise.

## What it means for testing our own models
Because the router is the single choice point, it is also the only place that can compare models fairly: same task, same gate, same accounting. As more models are configured, that turns into a straight readout of which one is more accurate, cheaper and safer for a given kind of work, measured on real tasks rather than on a vendor's benchmark.

## Where to look
- **Model router** page under the admin area: what was chosen, why, what it is estimated to have cost, and which models are reachable.
- \`npm run router:exercise\` proves the router switches correctly. It costs nothing, because it never calls a model.
- \`npm run models:probe\` proves the models it picks are really there. That one cannot be established without calling them.`,
  },
  {
    slug: "brief-review",
    parentSlug: "how-we-build",
    position: 6,
    title: "Reviewing a brief before the work starts",
    body: `## The problem it solves
Most expensive round trips on a task are not caused by a hard problem. They are caused by a fact the brief did not carry, and the same handful recur: where it has to work, how you would know it worked, what must not change, and what already exists that should be reused.

## What it does
Paste a brief on the Agent fleet page and it reports which of those facts are missing, each with the one question that would supply it. It runs before the work, not as a retrospective afterwards, because that is where the saving is.

## What it deliberately is not
- **Not a score.** There is no grade or percentage. A number invites people to optimise the number rather than write a better brief.
- **Not a model call.** The rules are deterministic, so they can be read, argued with and unit-tested, and they cost nothing to run on every brief.
- **Not a rewrite.** It appends questions rather than filling in answers, because a confident wrong assumption written back in your own voice is worse than the gap it replaced.
- **Not stored.** The brief text is never saved. Only the shape of the result is recorded, so the team can eventually answer "which fact do we most often leave out" without keeping text that names clients.

## The line it has to hold
A checker that fires on every input is one nobody reads, and it makes a careful brief feel the same as a careless one. A brief that names its target, its done condition and its boundary comes back clean, and there is a test that keeps it that way.`,
  },
  {
    slug: "agent-containment",
    parentSlug: "how-we-build",
    position: 5,
    title: "Agent containment",
    body: `## Keeping agents inside a boundary we have proven
In 2026 two AI labs published incidents where systems reached real infrastructure
from environments everyone believed were sealed. In both cases the environment
was *assumed* isolated and never checked. A third incident involved an agent that
performed well and concealed a broken commitment for a week.

Those are three different failures and we treat them as three different controls.

**A named list of what may be reached.** Per capability, not one global list: the
model API has no business reaching source control. Plain HTTP is refused
outright, because agent traffic carries credentials and instructions.

**A ceiling on one run.** Tokens, time, outbound calls and spend. Not a cost
control. It is a blast-radius control. A run that hits its limit pauses and asks
rather than continuing.

**A stop that works.** Checked before every step, not at the start of a run. A
stop that takes effect on the next run is a preference, not a stop.

**A boundary that is demonstrated.** Before a batch runs, hosts that must be
refused are attempted. If the refusal cannot be shown, the batch does not start.
Telling a model it is contained is worth nothing; the containment has to be
enforced outside it and re-proven.

Everything fails closed. A limit that cannot be read pauses the work rather than
permitting it, because an unknown spend is not a permitted one.`,
  },
  {
    slug: "untrusted-content",
    parentSlug: "core-tenets",
    position: 3,
    title: "Untrusted content never becomes code",
    body: `## The rule, and the bug that taught it
Our site generator built page source by pasting in text from the brief. Brief
text comes from an AI reading a wireframe and from whatever an operator types, so
it could close an element and inject a script, or open an expression and print a
build-time secret onto a public page.

The preview inside Instinct escaped it correctly, so the preview looked right and
only the deployed site was affected. That gap, where the thing you approve
differs from the thing the client gets, is the shape to watch for.

The fix was not a better escaper. It is that **supplied text is never emitted as
code.** It goes inside a quoted string, where a bracket cannot open an element
and a brace cannot open an expression.

Two habits came out of it:

- When something builds code or a prompt out of text it did not author, that is
  the moment to decide how the text is handled. A build check now refuses new
  generators that have not made that decision.
- Test the property, not a proxy for it. "The output must not contain
  \`<script>\`" is the wrong assertion, because the words *should* appear,
  inside a string, which is what rendering them as text looks like. The right
  assertion parses the output and checks the payload is data.`,
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
  {
    slug: "customer-success",
    parentSlug: null,
    position: 6,
    title: "Customer success",
    body: `## The gap this closes
In most software companies the person who feels a problem and the person who can fix it never meet. A client hits something confusing, tells their customer success manager, who writes a ticket, which a product manager triages, which reaches an engineer weeks later stripped of the detail that mattered. By the time it is fixed, nobody tells the client. The client learns that reporting things is pointless, so they stop, and the company concludes there are no problems.

That chain has four handoffs and loses information at each one. Our answer is not a better ticketing process. It is to remove the handoffs.

## What we build instead
**The client reports inside the product they are using, and the builder reads it in the same system.** No inbox in between, no re-typing, no summary of a summary. The report already knows who sent it, which organisation they belong to, and what screen they were on, because the product knows.

**The builder can stand where the client stands.** A support context points our session at one client's workspace, so we see exactly what they see instead of asking them to describe it. It is bounded, recorded and shown on screen the whole time it is open.

**We measure resistance, not just usage.** Counting page views tells you what worked. What we want is where people got stuck: the path that gets abandoned, the control nobody finds, the step that takes three attempts.

## Why this is more effective
- **Fidelity.** The report arrives with its context attached rather than as somebody's recollection of a phone call.
- **Latency.** The loop is client to builder to shipped, not client to CSM to ticket to sprint to release.
- **Honesty.** When the feedback path is one click and the reply is a fix they can see, clients keep reporting. Silence stops being ambiguous.
- **Scale.** It is the same layer for every client and every organisation, so the eleventh client costs no more customer-success process than the first.

## A prime example: A Weekend with Porsche
The dealer workspace is where this layer is being proved. Its Porsche Centers report from inside the product, their program leads see the whole rollout without asking anybody for a status update, and we can open any Center's workspace to help them, on the record.

It is a live client program, not a demonstration. What we learn there becomes the layer every other product gets.

## What is next
This is a direction, not a finished platform. The tools that exist today are listed in **The CS layer**, along with the ones we have not built yet, marked as such.`,
  },
  {
    slug: "cs-layer",
    parentSlug: "customer-success",
    position: 0,
    title: "The CS layer",
    body: `## What the layer is
A set of tools split by who is holding them. The builder's side is for seeing and fixing; the client's side is for reporting and understanding. They read and write the same data, which is what makes the loop close rather than fork.

Each item below is marked **live** where it is in production today in A Weekend with Porsche, or **planned** where it is not built yet. The distinction matters: a roadmap presented as a product is exactly the sort of thing this layer exists to stop.

## Our side (super-admin)
| Tool | State | What it is for |
|---|---|---|
| Object-level analytics dashboard | planned | Usage at the level of the thing being used (a guest record, a checklist, a template) rather than the page it sits on. |
| Broken user paths | planned | Journeys that start and do not finish, surfaced automatically rather than discovered in a call. |
| Areas of resistance | planned | Where people hesitate, retry or abandon. The signal that a screen is wrong before anybody complains about it. |
| Email template tester | live | Sends the real client template to yourself, so what you check is what they receive. The link it carries is inert and cannot be redeemed. |
| Multi-org switcher with header banner | live | Open one organisation's workspace to help them. Recorded on entry and exit, shown in a banner for as long as it is open, and it expires by itself. |

## The client's side
### Admins and program leads
| Tool | State | What it is for |
|---|---|---|
| Full-program analytics | live | Every group beneath them, rolled up, plus a per-group breakdown so a lead can name a specific example rather than quote an average. |
| Direct support form | live | A form inside the product that reaches us by email and lands in one queue. It never asks who they are or which organisation: the session knows. |
| Feedback page | live | For the smaller things that are not worth a support request but are worth saying. |

### Everyone below admin level
| Tool | State | What it is for |
|---|---|---|
| Analytics for their own group | live | The same page, scoped by the database to what is theirs. Not a different build, and not a permission that can be talked around. |
| Feedback page | live | The people who hit a problem most are the ones doing the work, so the feedback path is not an admin privilege. |

## The one rule
Every tool on the client's side writes into the same store the builder's side reads. There is no separate customer-success database, no export step and no reconciliation, because two systems that describe the same client always end up disagreeing about them.`,
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
