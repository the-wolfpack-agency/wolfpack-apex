# Client Deployment Playbook (internal)

Status: living document, first written 2026-08-26. The order of the phases is
the argument; the dates inside them move.

Companions: `docs/instinct-q4-pilot-plan.md` for the commercial shape,
`docs/ogiam-client-deployment-plan.md` for the QA and security engagement.

## What this is for

A client engagement that starts with documents and grows. Each phase adds one
system, and every phase is usable on its own, so a pause between them leaves
the client with something working rather than something half-built.

The order is deliberate: read before write, one system before two, and the
thing that proves value before the thing that costs the most to integrate.

## Before anything: what has to exist

None of this is engineering. It consumes more of the first month than the
build does, and starting it late is the single most common way a pilot slips.

| Needed | From whom | Why it blocks |
| --- | --- | --- |
| Microsoft 365 tenant consent | Their IT | Every document and calendar surface |
| A SharePoint library, named | Their operations lead | Nothing to read until one is chosen |
| One named role per persona | Their programme owner | Scoping is per role, not per person |
| A test account per persona | Their IT | Verifying what a dealer sees needs a dealer |
| Named escalation contact | Both sides | Somebody has to answer when a scan finds something |

Ask for these in the first meeting, in writing. They are not a formality: the
tenant grant alone has taken weeks elsewhere.

## Phase 1: documents, read only

**What it is.** Their SharePoint library, read into the Brain, answerable
through the assistant, scoped so a person is only quoted what their role may
read.

**Why first.** It needs one consent, touches nothing they run, and is
reversible by deleting rows. It also produces the demo moment: a question
answered from their own material, with the document named.

**The build, all of which exists today.**

1. Add the source in Admin, Connectors, SharePoint: site, library, folder.
2. Set the source's audience roles. Admin-only by default; widen deliberately.
3. Sync. Interrupted runs resume rather than restart; throttling is waited out.
4. Confirm with `npx tsx scripts/prompt-transcript.ts --file <their questions>`,
   run once per persona.

**Done when.** A person in each persona asks five questions from their own work
and gets answers from their own documents, and a question they should not be
able to answer returns nothing rather than somebody else's file.

**Watch.** `brain.retrieval_judged_irrelevant` should fall as the corpus
becomes theirs. `connectors.sharepoint.sync_resumed` rising across runs is a
sync making progress; flat at zero means it is starting over each time.

## Phase 2: the personas

**What it is.** Each role sees the capabilities that belong to their job, in
their own language, and nothing else.

**Why it matters more than it sounds.** A menu of sixty capabilities where six
are theirs is not a product somebody uses. It is also where wrong answers come
from: every irrelevant tool is one more thing a phrase can be matched against.

**The build.** Add the persona to `src/lib/assistant/tools/persona.ts`, naming
tools explicitly, and write one line of client-facing copy per tool. A tool
added later is not reachable until somebody names it, which is the point.

**Done when.** `what can you do`, asked as each persona, reads like a
description of that person's job. Nothing in it mentions our architecture, and
nothing in it is something they cannot run.

## Phase 3: one workflow that crosses systems

**What it is.** A routine that reads two or more of their systems and stops
where a person decides. The meeting brief with its pre-reads is the shipped
example: the calendar knows there is a review on Thursday, the library knows
which documents cover it, and neither knows the other exists.

**Why third.** It is the thing no single system they own can do, which is the
whole argument, and it is only credible once the documents behind it are theirs.

**Done when.** Somebody uses it without being asked to, twice.

## Phase 4: a second system, still read only

**What it is.** Whichever of their systems the pilot showed they reach for
most. Adapters exist for CDK, Cox/vAuto and DealerSocket; calendar, mail and
files are already wired through Graph.

**Why not sooner.** Every system added multiplies the surface that must be
correct. One that nobody asked for during the pilot is a system nobody will
use afterwards.

## Phase 5: writes, and only then

**What it is.** The assistant filing, sending or booking rather than reading.

**The rule.** Nothing is sent, filed or told to anybody without a person
confirming it, and that stays true after the pilot. A write path ships with an
audit row, a reversal, and a named person who owns the consequence.

## What is verified before every phase ships

Run in this order. Each answers a different question and none substitutes for
another.

| Command | Answers |
| --- | --- |
| `scripts/verify.sh` | Does the build hold together |
| `npm run models:probe` | Does every configured model actually answer |
| `npm run models:drift` | Has anything moved since last time |
| `scripts/prompt-transcript.ts` | What does a person actually see |
| `npm run scan:tenant-isolation` | Can one client's data reach another |

The transcript is the one people skip and the one that finds the problems. Every
answer-quality bug this month was found by reading an answer, not by a test.

## How the model spend is governed

- Most turns never reach a model. The assistant answers from their systems.
- Where a model is used, the router applies redaction both ways, the residency
  rule, the workspace budget ceiling and the constitution, at one chokepoint.
- A cheap model drafts; a second model from a different family reviews and may
  correct before anything is sent. Cheaper than one large call and checkable in
  a way one large call is not.
- `npm run models:bakeoff` produces the cost and sufficiency table for their own
  prompts rather than a benchmark built from somebody else's.

## What we say plainly to a client

- Retrieval is scoped by role. A person is not quoted a document they could not
  open.
- Answers that cannot be grounded are refused rather than guessed.
- Every model call is redacted, budgeted and audited at one place in the code.
- Nothing is written to their systems without a person confirming it.
- If a system is unavailable, the answer says so. It does not invent one.

## When to stop and re-plan

- The corpus is not theirs after two syncs. Retrieval quality will not recover
  by tuning; the library is wrong.
- A persona's questions are mostly things we cannot do. Better to widen the
  persona or narrow the promise than to answer badly.
- Access has not arrived by the end of month one. That is a programme problem,
  and continuing to build against it hides the fact.
