# Instinct Q4 Pilot Plan (internal)

Status: working plan, written 2026-08-26. Goal: put Instinct in front of a
corporate automotive client for a Q4 pilot, prove unification across systems
they already run, and earn the expansion from evidence rather than enthusiasm.

Companion to `docs/ogiam-client-deployment-plan.md`, which covers the QA and
security offering. Same governing instinct: read-only first, gate anything
active behind written authorization, keep a defensible audit record.

## The premise

A corporation's first two objections to an AI product are that they cannot
audit it and cannot predict what it costs. Instinct answers both by not being
an AI product in the way they expect. Most of what it does is a
permission-checked query against the client's own system, returning the
client's own data, with an audit row. The model is used where judgement is
genuinely required.

That is the pitch, and it is measurable rather than rhetorical.

## What exists today

Every figure here is countable in the repos, which matters because a technical
review will ask.

| Surface | Count |
| --- | --- |
| Estate | 1,918,808 lines across 7 repos |
| Assistant tools, each capability-gated | 60 |
| Whole-job routines | 14 |
| Microsoft Graph surfaces wired | 18 |
| DMS adapters behind one typed interface | CDK, Cox/vAuto, DealerSocket |
| Capability registry, role-mapped | 73 |
| Migrations | 406 |
| Test files | 1,401 |

The DMS adapter framework is what to lead with for an automotive client. It is
a registry with a typed contract per adapter rather than a bespoke integration,
so a system their dealers run is a new adapter, not a new product. The Auto
codebase also carries general-ledger and payroll integration.

## The four things to demonstrate

### Integration depth

Eighteen Microsoft Graph surfaces are wired: mail, calendar, files, people,
directory, Teams, Planner, OneNote, presence, mailbox settings and more. Each
maps one to one with a capability, so the permission grant IS the scope grant.

Every integration returns a typed result and never throws. A 403 from Graph
surfaces as "scope missing" with a reconnect path rather than a blank page.
That detail is the difference between a demo and something a corporation can
run on a Monday morning.

The SharePoint connector reads a document library into the knowledge base.
QuickBooks, GitHub and Resend are wired on the same pattern.

### The model router

Not a wrapper around a vendor SDK. A chokepoint that every model call passes
through, carrying:

- Provider-agnostic routing across capability tiers.
- Redaction in both directions, on the prompt and on the response.
- Residency enforcement. A request can be refused rather than processed in the
  wrong region.
- Retention policy, applied per workspace.
- Spend ceilings per workspace, which block a request rather than reporting an
  overspend afterwards.
- The OGIAM Constitution prepended at the chokepoint, so governance cannot be
  bypassed by a call site that forgets it.
- Untrusted-content fencing, so a retrieved document containing "ignore the
  question" cannot steer the model.
- Answer verification, with escalation when a model tried and fell short.

### Compliance

- Append-only audit log, hash-chained, with a database trigger enforcing
  immutability and a test that proves it.
- Row-level security keyed on workspace and user.
- A published security posture page.
- Crypto agility through a named-algorithm registry, with reserved ML-DSA slots.
  The claim is "quantum-migration-ready", never "quantum-safe today".
- An EU AI Act check available as a CI action. For a German-parent company this
  is worth more than anything else on this list.

### Security and gating

- Fifteen-minute access tokens with rotating refresh tokens and family
  revocation on theft detection.
- Content Security Policy in enforce mode, with violation reporting.
- Prompt-injection neutralisation on every retrieved chunk.
- A repo-wide tenant-isolation scan that fails the build when a
  workspace-scoped query is unclassified.
- Target-ownership verification before any scan runs.

## The argument that is not being made

Sixty days of production usage:

| Measure | Value |
| --- | --- |
| Deterministic tool answers | 3,962 |
| Model calls | 257 |
| Total model spend | $0.43 |

Roughly 94 per cent of assistant work never reaches a model. That is the
strongest technical argument available and it has not been leading the pitch.
It answers the audit objection and the cost objection at once, and it is a
measurement rather than a promise.

The moat is not the model. It is the gate around it.

Three more points that a corporate buyer will care about and that are easy to
forget to say:

- Instinct is sold per client with its own database, not as shared rows in a
  multi-tenant table. Corporations dislike co-tenancy.
- Degradation is honest. When a system is unavailable the answer says so
  instead of inventing one.
- Offboarding and deletion have an answer ready, because it will be asked.

## Phases

### September: prepare

- Run the SharePoint sync to completion against our own tenant and dogfood the
  result, so the corpus behind the pilot is the corpus we use daily.
- Accumulate a week of answer-verification data from real traffic, so the model
  decisions that follow are measured rather than argued.
- Bring the second and third model tiers online, so escalation and independent
  judging run across families rather than within one.
- Open the access conversation. Provisioning is what consumes the first month
  of a corporate pilot, and it starts before October.

### October: read-only unification

Two or three systems they already run. No writes. One dashboard showing a
figure no single system of theirs can produce.

Success condition: somebody looks at it and says they could not get that
before.

### November: one workflow

A single routine that crosses systems and stops where a person decides. Human
steps stay human and are measured. That measurement, what a person's own steps
cost them, is the most differentiated thing the product has.

### December: prove and decide

Show the audit trail, the spend, and the accuracy figures from real usage.
Decide expansion from the data.

## Sequencing note

The first month of a corporate pilot is access provisioning rather than
engineering. That conversation starts in September, so October opens with
systems already reachable.
