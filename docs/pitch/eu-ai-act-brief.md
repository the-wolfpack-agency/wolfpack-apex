# EU AI Act brief (the regulatory hook)

A timely, honest way to open a conversation with a regulated or EU-exposed buyer.
The EU AI Act is moving from text to enforced obligations, and the parts that bite
hardest are the ones nobody has evidence for: risk management, record-keeping,
human oversight, and transparency. This brief shows what the Act expects, what
evidence an organization actually needs, and how each maps to a product beat.

Pairs with messaging-and-category.md (the Comply beat language) and
outreach-and-deck.md (the regulated-org email). No em dashes. Never name a
competitor.

> **This is decision-support material, not legal advice and not a certification.**
> We are not your counsel and we do not issue conformity assessments. Use this to
> understand where governance evidence is needed and to scope the work; confirm
> your specific obligations with qualified legal and compliance advisors. OGIAM
> generates evidence that supports an audit. It does not make you compliant and it
> does not certify you.

---

## Why this is timely

The Act applies based on risk tier, and obligations for higher-risk and
general-purpose AI systems are phasing in. For most teams the practical problem is
not "are we in scope," it is "if a regulator, an auditor, or an enterprise
customer asked us to prove how our AI is governed, could we." Today, for most AI
deployments, the answer is no, because the AI was wired in faster than the
governance around it. That gap is the conversation.

This brief is organized around four obligation themes that recur across the Act's
requirements for AI systems. Treat the wording as plain-language summary, not a
clause-by-clause citation.

---

## The four obligations and what evidence each demands

### 1. Risk management
- **What the Act expects:** a continuous, documented process to identify,
  evaluate, and mitigate the risks an AI system poses across its lifecycle, not a
  one-time sign-off.
- **Evidence an organization needs:** records of risks tested, when, with what
  result, and what was done about the failures. Proof the process is ongoing, not
  a launch-day artifact.

### 2. Record-keeping
- **What the Act expects:** automatic logging of events over the system's
  lifetime, sufficient to trace what the system did and to support post-market
  monitoring.
- **Evidence an organization needs:** a durable, trustworthy log of the system's
  decisions and actions that cannot be quietly altered after the fact.

### 3. Human oversight
- **What the Act expects:** the system is designed so a human can understand,
  intervene in, and where needed override its operation, with oversight that is
  real rather than nominal.
- **Evidence an organization needs:** proof that defined actions route to a human,
  that the human's decision is captured, and that override is a designed path, not
  an emergency hack.

### 4. Transparency
- **What the Act expects:** clarity about where and how AI is used, with
  information that lets affected parties and overseers understand the system.
- **Evidence an organization needs:** an accurate inventory of AI surfaces in use
  and a clear mapping from what the system does to the controls and obligations
  that cover it.

---

## How each obligation maps to a product beat

This is the crosswalk to use in the room. Each obligation has a product beat that
produces the evidence, and the beat names match the message house in
messaging-and-category.md.

| Obligation theme | Evidence needed | Product beat | How the evidence is produced |
|---|---|---|---|
| Record-keeping | Durable, unalterable log of AI decisions | Ledger | Every gate decision is appended to a hash-chained, tamper-evident record; if a decision cannot be recorded, the action does not run |
| Human oversight | Defined actions route to a human; override captured | Gate (escalate) | The deterministic policy can decide escalate-to-human as a first-class outcome; the routing and the human verdict land in the ledger |
| Risk management | Ongoing record of risks tested and results | Assure (continuous red-team) | The gate is exercised against a standing adversarial corpus on a schedule, producing dated pass and fail records over time, not a one-off |
| Transparency | Accurate inventory and obligation mapping | Discover plus Comply | The read-only shadow-AI scan inventories AI surfaces and the ungoverned gap; the compliance crosswalk maps live controls to the framework |

The honest framing for all four: we turn obligations that are usually answered
with intentions into evidence derived from controls that are actually running. The
auditor or the customer gets records, not assurances.

---

## The Comply beat in one paragraph (say this)

> "The hard part of the EU AI Act is not the policy, it is the proof. Auditors and
> enterprise customers want record-keeping, human oversight, and risk testing
> shown as evidence, not described as intentions. We generate that evidence from
> live controls: a tamper-evident record of every AI decision, a human-escalation
> path that is captured, continuous adversarial testing with dated results, and an
> inventory mapped to the frameworks. To be clear, this is decision-support
> evidence that accelerates your audit. It is not legal advice and it is not a
> certification. The fastest way to see where you stand is a free, read-only scan
> of your AI surface."

---

## What to hand a prospect after this lands

- The free read-only shadow-AI scan (the wedge: their own ungoverned AI surface).
- The public sample artifact at `/governance-sample` (an illustrative, sanitized
  example of the governance and compliance summary, safe to forward as a URL).
- The Comply beat in the live demo (demo-runbook.md), where they see the coverage
  view generated from real decisions rather than a static binder.

## How to update this doc

As enforcement milestones and guidance firm up, tighten the obligation summaries
to match current regulatory text. Keep the crosswalk table and the disclaimer
fixed; they are the spine. Never let an update turn "decision-support evidence"
into a compliance or certification claim.
