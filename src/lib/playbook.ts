/**
 * The client deployment playbook, as the product serves it.
 *
 * WHY THE CONTENT LIVES IN A MODULE RATHER THAN IN docs/. A page that reads a
 * markdown file from disk at request time depends on that file being traced
 * into the serverless bundle, and this repo has already lost /engineering to a
 * markdown path that did not survive the Vercel build. A module is imported,
 * so it either compiles or the build fails, which is the failure mode worth
 * having.
 *
 * ONE COPY. It was briefly a doc and a page, which is two things to update and
 * one of them silently stale. The doc was the draft; this is the artefact, it
 * is reviewed in a diff like any other change, and the page renders exactly
 * what is here.
 *
 * It is expected to change as capability changes. That is the point of putting
 * it in front of the team rather than in a folder: the phases are stable and
 * the dates inside them are not.
 */

/** Shown on the page so a reader knows how current this is. */
export const PLAYBOOK_UPDATED = "2026-08-30";

/* A plain template literal, not String.raw: raw strings do not process escape
   sequences, so the escaped backticks this content needs would have rendered
   as visible backslashes on the page. */
export const CLIENT_DEPLOYMENT_PLAYBOOK = `# Client Deployment Playbook (internal)

Status: living document, first written 2026-08-26. The order of the phases is
the argument; the dates inside them move.

Companions: \`docs/instinct-q4-pilot-plan.md\` for the commercial shape,
\`docs/ogiam-client-deployment-plan.md\` for the QA and security engagement.

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
| One named role per persona | Their program owner | Scoping is per role, not per person |
| A test account per persona | Their IT | Verifying what a dealer sees needs a dealer |
| Named escalation contact | Both sides | Somebody has to answer when a scan finds something |

Ask for these in the first meeting, in writing. They are not a formality: the
tenant grant alone has taken weeks elsewhere.

### Also ask for: their Copilot usage export

If they run Microsoft 365 they very likely have Copilot, and its usage report
is the cheapest read we will ever get on how AI is actually landing in their
organization. Ask their admin for a CSV export of **Copilot usage** from the
Microsoft 365 admin center, thirty days, and the version 2 report if the
console offers it.

**What it contains.** Per person: which Copilot surfaces they touched (Teams,
Word, Excel, PowerPoint, Outlook, OneNote, Loop, Chat), when they last touched
each, and in the version 2 report how many prompts they submitted and on how
many days. Identities are hashed when the tenant has "conceal user
information" set, which many do.

**What it does NOT contain, and this is the point.** No prompt text and no
response text. It is shape without content, which is the same thing we ask of
our own decision data. There IS an API that returns full prompts and replies,
and we deliberately do not ask for it: a vendor who takes that has a much
harder conversation with a legal team than one who does not, and we do not
need it to be useful.

**Ask for the export, not the API.** \`Reports.Read.All\` is tenant-wide admin
consent, which is a materially bigger request than the delegated scopes Phase 1
already needs, and it should not be bundled into the first grant. A CSV a
person exports by hand answers the same question this month and costs them
nothing. If it turns out to be worth reading every week, THEN ask for the
scope, with the export as the argument for it.

**What it can and cannot tell you.** It is adoption data, not decision data:
who uses Copilot and how often, never what it changed or whether the change
was good. It answers "is the investment being used", which is a real question
a lot of buyers cannot currently answer, and it does not answer "is it making
better decisions". Say which one you are answering.

**If they run something else.** ChatGPT Enterprise, Claude and Glean each have
their own admin export and no Microsoft surface. And if nobody is sure what is
in use, Entra sign-in logs and Defender for Cloud Apps show which AI services
staff are actually signing into, which is a different and often more
uncomfortable report.

## Week one: learn their words before quoting a number

A figure computed correctly from well-formed data can still be wrong by ten
times, and nothing in the data says so.

Ours was calendars. Of 801 entries across six people, 30 were somebody being
away and held 2,763 hours, 64 were trips and events holding 2,304, and 707
were meetings holding 557. Eleven per cent of the calendar carried ninety per
cent of the hours and none of it was a meeting. A "how much time does this
team spend in meetings" answer built on that reports five and a half thousand
hours where the truth is five hundred and forty-seven.

The events were well formed. The arithmetic was correct. It was found because
somebody who knows that calendar said an entry reading OOO is a vacation day.

**Every client has one of these and it will not be OOO.** A dealership marks
floor duty and demo drives on the same calendar as meetings. An agency blocks
shoot days. Somebody prefixes every placeholder with HOLD. The same shape
turns up wherever a local convention hides inside well-formed data: a CRM
stage that means "dead" but is spelled like a live one, a DMS status code
every branch uses differently, an account named for a project rather than a
customer.

**So it is asked, in week one, before any figure is quoted.** Run the
calibration on their calendar and their records, take the entries that carry
the weight, and put them in front of somebody who knows. The report names them
without knowing what they are:

> 19 of 801 calendar entries account for more than half the hours. That is
> usually a local convention rather than a busy team. The largest are: Avryl
> Trip, Alicia OOO, F1 Las Vegas. Somebody who knows this calendar should say
> what those are.

It asks and never concludes, because reading the data is exactly what does not
produce the answer.

**What comes back becomes configuration, not code.** Their words are recorded
per deployment rather than added to a built-in list, because a pattern right
for one client is wrong for the next: "demo" is a test drive at a dealership
and a sales meeting everywhere else.

**The rule this sets.** No number about how their people spend time, how much
is in a system, or how a pipeline is moving goes in a document or on a screen
until somebody on their side has told us what the outliers are. A number
quoted before that conversation is a number we may have to withdraw, and
withdrawing one costs more than the week it would have taken to ask.

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
4. Confirm with \`npx tsx scripts/prompt-transcript.ts --file <their questions>\`,
   run once per persona.

**What they can ask, as of 2026-08-30.** Three shapes, and the difference
between them is the difference between a search box and an assistant:

| They say | They get |
| --- | --- |
| "what does the SOW say about payment" | The clause, quoted, with the document named |
| "summarize the onboarding document" | Prose across the whole document |
| "what documents do we have about training" | A browsable list |

The middle row is new. Until this week, asking for a summary returned a list of
filenames: somebody who asked for a summary received a filing cabinet. Asking a
document a question and asking the library what it holds are different
questions, and they now get differently shaped answers.

**Done when.** A person in each persona asks five questions from their own work
and gets answers from their own documents, and a question they should not be
able to answer returns nothing rather than somebody else's file.

**Watch.** \`brain.retrieval_judged_irrelevant\` should fall as the corpus
becomes theirs. \`connectors.sharepoint.sync_resumed\` rising across runs is a
sync making progress; flat at zero means it is starting over each time.

## Phase 1, both sides: corporate and dealer

Phase 1 above describes what we read. This describes who we serve with it, and
it is the part that differentiates the engagement. Most vendors in this space
pick a side: a corporate reporting tool that dealers resent, or a dealer tool
corporate cannot see. Serving both from one ingest is available to us because
we deploy a dashboard rather than building into their existing products, and
that is a sequencing advantage more than a technical one.

The model is the one that already worked. A Weekend with Porsche shipped a
dealer-facing surface and a corporate view over the same data, and it worked
because the dealer surface was useful on its own before anyone rolled anything
up.

### For the dealer: information that helps close

The dealer side has to earn its place in a salesperson's day. What it carries:

| Panel | What it answers |
| --- | --- |
| Client breakdown | Who this customer is, across every system that knows them |
| Pre-client brief | What to know before walking into the conversation |
| Finance position | What they currently hold, and what that implies |
| Current lease | Term, maturity, and the window that makes a conversation timely |

Every one of those exists somewhere already. The value is not new data, it is
the join: the brief nobody has time to assemble by opening four systems before
a customer walks in.

### For corporate: an umbrella over dealers who are already served

The corporate side is a roll-up of the same records. Group performance, the
comparison between dealers, and the picture that no single dealer's system can
produce because no single dealer has the others' data.

It costs almost nothing to build once the dealer side exists, because it reads
the same store. That is the whole argument for this shape.

### The order is not negotiable, and it is the real insight

**Dealer first. Corporate second.** Not because the corporate view is worth
less, but because building it first makes it weaker.

The tool depends on the people using it. Every figure in a corporate roll-up
arrives because somebody at a dealership found the thing useful enough to work
in, so the completeness of the corporate picture is decided by how well the
dealer side does its job. Build the roll-up first and it reports on a tool
nobody has reason to use yet, which produces a thin picture at exactly the
altitude where decisions get made.

Serve the dealer first and both sides win from the same work. The dealer gets a
brief that helps them close, corporate gets a complete picture because the data
is a by-product of people doing their jobs well, and the analytics underneath
show whether the tool is actually earning its place for either of them.

So the corporate value is real and it is delivered second. Inverting the order
is a slower path to the same place, with a thinner picture at the end of it.

### What this deliberately does not depend on

**DMS access, in phase 1.** The dealer management system is the slowest
dependency in this industry: access is controlled by the vendor, negotiated
rather than granted, and priced. A phase that cannot start until a DMS contract
is signed is a phase that has not started.

So phase 1 is built on what one tenant consent already reaches, and the DMS
becomes phase 4, the second system chosen by use. If DMS access arrives early,
it slots in. If it takes two quarters, nothing was waiting on it.

### What changes because this is automotive

A dealer arranging financing is a financial institution under the Gramm-Leach-
Bliley Act, so customer finance and lease records fall under the Safeguards
Rule. That is not an obstacle, it is the reason the controls we already built
are worth more here than in most industries: scoped retrieval, an audit trail
that records every document sent to a model, redaction at one chokepoint, and
a written answer to who may see what.

Confirm the client's own interpretation with their counsel rather than assuming
ours. The point is that the questions their compliance function will ask have
answers already, and those answers are in this document.

### What actually gets built

The real implementation is a separate repository: the client's own deployment,
under whatever name they choose. What carries across is the substrate, not the
screens. The gate, the router, the audit chain, the retrieval scoping and the
tenancy model are the product; the dashboards are configuration over it.

That is the same relationship the Porsche build has to this one, and it is why
a second engagement costs a fraction of the first.

## Phase 2: the personas

**What it is.** Each role sees the capabilities that belong to their job, in
their own language, and nothing else.

**Why it matters more than it sounds.** A menu of sixty capabilities where six
are theirs is not a product somebody uses. It is also where wrong answers come
from: every irrelevant tool is one more thing a phrase can be matched against.

**The build.** Add the persona to \`src/lib/assistant/tools/persona.ts\`, naming
tools explicitly, and write one line of client-facing copy per tool. A tool
added later is not reachable until somebody names it, which is the point.

**Done when.** \`what can you do\`, asked as each persona, reads like a
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

## The system we build for them

What follows is our own architecture, described as the thing a client gets. It
is not a proposal: every part named here is running in this product today, and
the phase column says when a client sees it.

### Shape

\`\`\`text
their people
    |
the assistant  (one surface: ask, and be answered)
    |
the gate       (who is this, what may they reach, what may they be told)
    |
+---------------+---------------+----------------+
|               |               |                |
tools           retrieval       the router        connectors
(their          (their          (only where       (their systems,
 systems,        documents,      judgment         read first,
 answered        scoped by       is needed)        written later)
 directly)       audience)
\`\`\`

The important line is the one between tools and the router. Most questions are
answered by reading their own systems and never reach a model at all. In our
own production that is roughly nineteen turns in twenty. It is what makes the
product cheap, auditable and predictable, and it is the opposite of how a
chatbot works.

### Data flow, phase 1

1. A document is read from their library by a connector holding a delegated
   token. It is never read with more access than the person who authorized it.
2. Text is extracted, split into passages, and each passage is embedded.
3. The document is described once, at ingest, so retrieval can match the
   document rather than only a slice of it.
4. Passages are stored in their database and their vector index, each carrying
   the audience of the library it came from.
5. A question retrieves only passages whose audience includes the asker's role.
6. If nothing relevant is found, the answer says so.

Nothing in that path writes to their systems.

### Where their data lives

| Store | Holds | Why |
| --- | --- | --- |
| Postgres | The record of everything: documents, chunks, audit, analytics | Source of truth, transactional, row-level scoped |
| Vector index | Embeddings of passages | Semantic retrieval |
| Graph store | Relationships between people, documents and topics | Optional. Absent, the other two still work |

One client, one database. Not rows in a shared table with a tenant column.

### Who may see what

Three separate gates, deliberately not one:

- **Role.** What capabilities a person's job includes. A dealer sees the
  handful that are theirs, not the sixty that exist.
- **Audience.** What documents a role may be quoted. Inherited from the library
  the document came from, because that library is already somebody's permission
  model and inventing a second one would let the two disagree.
- **Tenancy.** Whose data this is at all, enforced at the query, with a
  repository-wide scan that fails the build if a scoped query is missing its
  filter.

All three fail closed. A lookup that errors returns nothing rather than
everything: a retrieval that fails is a bad answer, and a retrieval that leaks
is an incident.

### What is recorded

- An append-only audit log, hash-chained, with the chain verifiable after the
  fact. Security-relevant actions only: authentication, capability grants,
  exports, and every document sent to a model.
- Analytics for everything else, which is how the product is measured and
  improved rather than how it is policed.
- The audit log never stores the content it is evidencing. Recording the
  document text would make the log a second copy of the library, outside the
  library's own retention rules.

### Model governance

Every model call passes one chokepoint, and the chokepoint applies:

| Control | What it does |
| --- | --- |
| Redaction | Strips credentials and identifiers, outbound and inbound |
| Residency | Refuses to process where the policy does not allow it |
| Budget | Blocks a call that would exceed the workspace ceiling |
| Constitution | Prepends the governing rules so a call site cannot skip them |
| Fencing | Marks retrieved text as untrusted so a document cannot issue instructions |
| Verification | Reads the answer before a person does |
| Review | A second model, from a different family, may correct it |
| Response inspection | Refuses to pass on credential exfiltration, fetch-and-run, or instructions aimed at a downstream system |

A cheap model drafts and a second model checks. That is less expensive than one
large model and more defensible, because two families had to agree and any
disagreement is in the record.

### The ontology

The nouns the system knows about, and how they relate. This is what makes
cross-system answers possible, and it is the part that grows with each phase.

\`\`\`text
Person  --works at-->  Organization
  |                        |
  |--attends-->  Meeting --covers--> Document --lives in--> Library
  |                 |                    |                      |
  |--owns-->    Task  |                Topic              Audience
  |                    \                                       |
  |--holds-->  Capability  <--governs--  Role  <----------------+
\`\`\`

- **Person, Role, Capability.** A person has a role; a role carries
  capabilities; a capability is checked at every call.
- **Document, Library, Audience, Topic.** A document comes from a library, the
  library sets its audience, and topics are written at ingest so it can be
  found by somebody who does not know its filename.
- **Meeting.** Joins people to documents by subject, which is the join no
  single system of theirs can make.
- **Task, Routine, Step.** A routine is an ordered set of steps; a step is
  either something the system does or something a person does, and the
  human ones are measured because that measurement is what tells them where
  the time actually goes.

Each later phase adds nouns rather than replacing them: a DMS adds Vehicle and
Booking, a CRM adds Account and Opportunity, and the relationships they already
have to Person and Organization are what make the second system worth more than
the first.

### The agents, and the gate that makes them safe

The client will ask about agents. The honest and more interesting answer is
that the agent is the least novel part; the gate around it is the product.

**What an agent is here.** Not a chat loop with tools bolted on. An agent has an
identity, a role, and a set of operations it has scanned and been granted. It
acts ON BEHALF OF a named person through a delegation token, so it can never
reach anything that person could not, and the audit shows both: who acted, and
who authorized.

**The gate.** A model proposes; the gate decides, executes and records. The
model never touches a system directly. Everything an agent can do is a
declared operation naming an existing internal route, the capability it needs,
and the fields to extract from an instruction. That has three consequences a
client cares about:

- An agent cannot invent a capability. If an operation is not declared, there
  is no path to it, however the instruction is phrased.
- What an agent may do is reviewable as a list, not inferred from a prompt.
- Adding a capability is a few declarative lines and a review, so the surface
  grows deliberately rather than by accident.

**What surrounds it, all of it already built:**

| Layer | What it does |
| --- | --- |
| Identity and on-behalf | The agent acts as a person, never as itself |
| Operation registry | The complete, declared list of what it can do |
| Approvals | A human confirms before anything irreversible |
| Grounding | Answers come from their documents, not from the model's memory |
| Behavior evals | The agent is scored against a fixed task set, per model version |
| Drift detection | The same tasks re-run, and a change in behavior is reported |
| Failover | A provider outage degrades rather than stops |
| Audit | Hash-chained, so the record of what an agent did cannot be edited |

**Why this matters more than the agent.** Every one of those is a question a
corporation asks about automation and usually cannot get answered: what may it
do, who authorized it, what did it actually do, how do we know it still
behaves the way it did last month. An agent without them is a demo. The gate
is what makes it something an enterprise can sign off.

**Where agents fit in the phases.** Not in phase one. An agent is worth having
when there is a repeated process a person is doing by hand across two systems,
and the pilot is what identifies which one that is. Introducing agents before
that is choosing the automation before finding the work.

### What each phase adds

| Phase | Systems | New nouns | Writes |
| --- | --- | --- | --- |
| 1 | Document library | Document, Library, Audience, Topic | None |
| 2 | Same | Role, Capability, Persona | None |
| 3 | Library plus calendar | Meeting, Person | None |
| 4 | One of theirs, chosen by use | Depends: Vehicle, Account, Ticket | None |
| 5 | Same | Task, Confirmation | Behind a person, always |

## The questions they will ask, and the answer we already have

Every one of these has been asked by somebody evaluating automation, and every
answer below is a thing that exists in the product today rather than something
we would build if asked. Where the honest answer is a boundary, it is stated as
a boundary.

### When it goes wrong

**What happens if your system is down when we ask something?**
The answer names what could not be reached, says plainly that nothing has been
lost and nothing needs re-uploading, and puts the fault on our side rather than
on the question. Before that, a brief failure is simply retried: most throttles
and connection blips clear in under a second and never reach a person.

**How would we know the difference between "you have nothing on that" and "your
search is broken"?**
Because we say which. That distinction is the single failure this product has
had to fix most often, in four separate places, and it is now the thing every
number on the client dashboard is written to preserve. Where a check cannot be
evidenced as running, the page says so instead of showing a clean-looking zero.

**Somebody will paste a card number or an ID into the chat. Then what?**
It is removed before the prompt leaves our system, so no model or outside
service receives it, and the person is told that it was. If the message was
otherwise a real question, the question is still answered. Tested with a card
number, a national ID, bank details and an API key, including pasted alongside
a genuine question.

### Their data

**Where does our data live, and is it mixed in with your other clients?**
One client, one database. Not rows in a shared table with a tenant column. The
separation is physical, so a query written wrongly cannot reach across it.

**Could another client's data ever reach us?**
Tenancy is enforced at the query, and a scan runs across the whole repository
that fails the build if any workspace-scoped query is missing its filter. The
count of unclassified queries has to be zero for a change to ship. That check
found a query in this very section's own feature while it was being written,
which is the point of having it.

**What actually leaves our tenant when a model is called?**
Only the passages needed to answer, redacted for credentials and identifiers on
the way out and again on the way back, at one chokepoint every call passes
through. Most questions never reach a model at all: in our own production it is
roughly nineteen turns in twenty.

**Do you train anything on our data?**
No. Their content is retrieved to answer their questions and is not used to
train a model.

**Who at your company can see our data?**
The same three gates that apply to their people apply to ours: role, audience
and tenancy. There is no support path that reads a client's documents outside
them, and every document sent to a model is written to the audit log.

**A document was ingested that should not have been. Now what?**
Audience is inherited from the library the document came from, so the first
answer is that it was already scoped by their own permission model rather than
by a second one we invented. Removing it removes its passages and its
embeddings, and the audit log shows every answer it was ever used in. The log
holds the reference, never the content, so deleting the document does not leave
a copy of it inside the evidence.

### The agents

**What can an agent actually do?**
Read the list. Everything an agent can do is a declared operation naming an
existing internal route, the capability it needs and the fields to take from an
instruction. It is reviewable as an inventory, not inferred from a prompt.

**What stops it doing something we did not intend?**
It cannot invent a capability. If an operation is not declared there is no path
to it, however the instruction is phrased. A model proposes; the gate decides,
executes and records. The model never touches a system directly.

**What stops it running away?**
Every act an agent takes on a person's behalf passes an hourly ceiling first,
set per agent rather than per workspace so one misbehaving agent cannot spend
everybody else's allowance before anything trips. Refused attempts are counted
as well as executed ones, because a refusal that is not counted is a ceiling
you walk through by retrying. If the limiter cannot be read, the agent does not
act: an agent that keeps working when its limiter is broken is an agent with no
limiter. Hitting the ceiling notifies the agent's owner, so the person
accountable hears it from us rather than from a bill.

**Who is accountable when an agent acts?**
A named person. An agent acts on behalf of its owner through a short-lived
delegation token good for a single act, so it can never reach anything that
person could not. The audit shows both: who acted, and who authorized.

**Can we stop it?**
Pause or revoke, immediately. Revoke kills the credential. Both are
hash-chained, as is raising an agent's ceiling, because permitting an agent to
do more unsupervised is exactly as security-relevant as stopping it, and who
lifted a limit is the first question an incident review asks.

**How do we know it still behaves the way it did last month?**
It is scored against a fixed task set, attributed to the model version that
produced the score, and the same tasks are re-run so a change in behavior is
reported rather than discovered. A model vendor shipping a new version is a
change we detect.

**Can it write to our systems?**
Not until phase five, and then only behind a person confirming. Anything
irreversible requires an approval before it runs.

### Whether to trust the answers

**What happens when it does not know?**
It says so. An answer that cannot be grounded in their documents is refused
rather than guessed, and a retrieval judged irrelevant is discarded instead of
being quoted at somebody.

**Can one of our documents tell it to do something?**
Retrieved text is marked as untrusted before it reaches a model, so a document
is content to be read and not an instruction to be followed. Separately, the
response is inspected before a person sees it and refused if it carries
credential exfiltration, fetch-and-run, or instructions aimed at a downstream
system.

**How do you know the answers are any good?**
A cheap model drafts and a second model from a different family reviews and may
correct it before anything is sent. Two families had to agree, and any
disagreement is in the record. Beyond that, we read transcripts: every
answer-quality problem found this month was found by reading an answer, not by
a test passing.

**How do we know it is getting better rather than just different?**
Irrelevant retrievals, refused promotions, improved answers and flagged
responses are all recorded as events, so the trend is measurable rather than
asserted.

### Cost and lock-in

**What does this cost to run?**
Most turns cost nothing at a model, because they are answered from their own
systems. Our own sixty-day figure across thousands of assistant turns is well
under a dollar. The bakeoff produces the cost and sufficiency table for their
prompts rather than a benchmark built from somebody else's.

**What stops a runaway bill?**
A workspace budget ceiling at the same chokepoint as everything else, checked
before the call rather than reported after it, plus the per-agent operation
ceiling above.

**Are we locked to one model vendor?**
No. Providers are configuration, and the router selects across families,
including small open-weight models where they are sufficient. That is also the
failover story: a provider outage degrades rather than stops.

### Continuity and compliance

**What if a system of ours is unavailable?**
The answer says so. It does not invent one. Integrations return typed errors
and never throw into the surface a person is using.

**Can we audit what happened, and can the log be edited?**
Append-only and hash-chained, with the chain verifiable after the fact and
immutability enforced at the database rather than by convention.

**What if we want to leave?**
It is their database. Postgres is the source of truth and everything durable is
in it, exportable without us.

## What is verified before every phase ships

Run in this order. Each answers a different question and none substitutes for
another.

| Command | Answers |
| --- | --- |
| \`scripts/verify.sh\` | Does the build hold together |
| \`npm run models:probe\` | Does every configured model actually answer |
| \`npm run models:drift\` | Has anything moved since last time |
| \`scripts/prompt-transcript.ts\` | What does a person actually see |
| \`npm run scan:tenant-isolation\` | Can one client's data reach another |
| \`scripts/probe-outage.sh\` | What a person is told when a dependency is down |

The transcript is the one people skip and the one that finds the problems. Every
answer-quality bug this month was found by reading an answer, not by a test.

The outage probe is new, and it exists because the same was true of failures.
Nothing had ever checked what a person sees when a dependency is down, and the
answer turned out to be that the product told them their documents were
missing. It points a dependency at a closed port so the failure is real on the
real code path, and it fails if any degraded case invites somebody to
re-upload.

## How the model spend is governed

- Most turns never reach a model. The assistant answers from their systems.
- Where a model is used, the router applies redaction both ways, the residency
  rule, the workspace budget ceiling and the constitution, at one chokepoint.
- A cheap model drafts; a second model from a different family reviews and may
  correct before anything is sent. Cheaper than one large call and checkable in
  a way one large call is not.
- \`npm run models:bakeoff\` produces the cost and sufficiency table for their own
  prompts rather than a benchmark built from somebody else's.

## What we say plainly to a client

- Retrieval is scoped by role. A person is not quoted a document they could not
  open.
- Answers that cannot be grounded are refused rather than guessed.
- Every model call is redacted, budgeted and audited at one place in the code.
- Nothing is written to their systems without a person confirming it.
- If a system is unavailable, the answer says so, names what could not be read,
  and states that nothing has been lost and nothing needs re-uploading. Worth
  saying plainly that this line was aspirational until 2026-08-30: with the
  model provider unreachable the product used to reply "I don't have
  information on that yet, you can help me learn by adding it to the Knowledge
  Base" about a document it was holding. It is now true, tested by
  \`scripts/probe-outage.sh\`, and that check runs before a phase ships.
- A brief failure is retried before anybody sees it. Throttling and connection
  blips clear in under a second and no longer end somebody's question.
- Something pasted by mistake never reaches a model. A card number, national ID
  or API key typed into a question is removed before the prompt leaves the
  system, and the question is still answered from their documents.

## When to stop and re-plan

- The corpus is not theirs after two syncs. Retrieval quality will not recover
  by tuning; the library is wrong.
- A persona's questions are mostly things we cannot do. Better to widen the
  persona or narrow the promise than to answer badly.
- Access has not arrived by the end of month one. That is a program problem,
  and continuing to build against it hides the fact.
`;
