# OGIAM outreach + deck

How to land the meeting and tell the story once you are in it. Pairs with
demo-runbook.md (the live demo) and pitch-kit.md (the language). The wedge in
every channel is the same: a free scan that shows them their own ungoverned AI.

No em dashes anywhere (house style).

---

## The one hook that opens every door

"We can scan your codebase and show you every place AI is already wired into your
systems, including the ungoverned ones and any leaked AI keys, in a few minutes."

It works because it is concrete, fast, free, and a little scary. Lead with it in
cold email, LinkedIn, and the first 60 seconds of any call.

---

## Cold email templates

Keep them short, specific, and about THEM. One ask: a 20-minute scan readout.

### To a CISO / Head of Security
Subject: your ungoverned AI, in a 20-minute readout

> Hi [name],
> Your teams are almost certainly already using AI in places security has not
> mapped: agents acting on systems, model calls in code, keys in config. Most
> orgs cannot answer "what did our AI do, and can we prove it."
> We built the control plane for that: a deterministic gate in front of every AI
> action, a tamper-evident record of all of it, and continuous proof it holds.
> The fastest way to show value is a free scan of one repo. You will see your own
> ungoverned AI and any leaked keys in a few minutes. Worth 20 minutes this week?
> [name]

### To a VP Eng / Platform lead
Subject: governing the AI your team is shipping

> Hi [name],
> Your team is shipping AI features and AI-written code faster than review can
> keep up. The risk is not the model, it is the ungoverned actions and the code
> nobody gated.
> We give AI agents identities and least-privilege like employees, gate every
> action deterministically, and continuously red-team the gate to prove it holds.
> Mind if we run a free scan on one repo and show you your AI surface? 20 minutes.
> [name]

### To a regulated org (fintech / health / infra)
Subject: SOC2 / EU AI Act evidence for your AI, generated not assembled

> Hi [name],
> If you are deploying AI in a regulated environment, the hard part is proving it:
> record-keeping, human oversight, risk testing. Auditors want evidence, not
> intentions.
> We generate that evidence from live controls: a tamper-evident decision ledger,
> continuous adversarial testing, and a coverage report mapped to SOC2, ISO 42001,
> NIST AI RMF, and the EU AI Act. We start with a free scan of your AI surface.
> 20 minutes to show you?
> [name]

### LinkedIn (connect, then message)
- Connect note: "Building the control plane for AI agents. Would value your view
  on how [their company] is governing AI in production."
- First message after accept: the one hook above, plus "free scan of one repo,
  20-minute readout, no commitment."

### The follow-up (after a demo)
> Thanks for the time. Here is the one-pager and the recording. The concrete next
> step is the scan: if you can get us read access to one repo, we will put a real
> number, your ungoverned AI count and any leaked keys, in front of you by [day].

---

## Discovery call script (20 minutes)

Goal: qualify, create the alarm, and book the scan. Talk 30%, listen 70%.

1. **Frame (60s):** the one hook.
2. **Qualify (5 min), ask and shut up:**
   - "Are you deploying AI agents, or AI features that take actions, in production
     or close to it?"
   - "Who governs what those agents are allowed to do today?"
   - "If an auditor or a customer asked you to prove what your AI did last month,
     could you?"
   - "Is anyone pushing you on AI compliance yet, SOC2, ISO 42001, the EU AI Act?"
   - "How is AI-written code reviewed before it merges?"
   Their answers tell you which of the three email angles to lean into.
3. **Show, do not tell (8 min):** run the demo-runbook flow (Discover, Govern,
   Assure). Let the ungoverned-AI screen do the work.
4. **The close (3 min):** the offer and the ask from the runbook. Book the scan
   before you hang up. A booked scan is the only real outcome of the call.

### Two objections you will hear (full set in pitch-kit.md)
- "Won't Microsoft or Anthropic build this?" -> "They are racing on models;
  governing all of them neutrally is not their focus, and a model vendor policing
  itself is a conflict a CISO will not accept. We are the neutral system of record."
- "Is this a feature, not a company?" -> "A control plane plus a tamper-evident
  audit system plus a compliance surface plus a data flywheel is a platform. IAM
  was once a feature too; it became Okta and CyberArk."

---

## Pitch deck outline (10 to 12 slides)

Built for any investor; cut to 6 slides for a client. Keep one idea per slide.

1. **Title.** OGIAM. The control plane for AI agents. One line: "AI proposes, we
   deterministically decide, execute within your access, and prove every action."
2. **The shift.** AI agents are the next workforce. They act, not just chat.
3. **The gap (the fear).** Enterprises cannot control or prove what AI does, so
   security blocks the rollout. No system of record exists for AI actions.
4. **Why now.** Agent frameworks and MCP exploding, EU AI Act and ISO 42001
   landing, security teams blocking AI. The window is open.
5. **The product, in three beats.** Discover (your ungoverned AI), Govern (the
   deterministic gate plus signed ledger), Assure (continuous red-team). One
   screenshot each. This is the demo, compressed.
6. **The wow.** Test a governance policy against your real decision history before
   you enforce it. Almost no one can, because it needs the ledger we already keep.
7. **The moat.** We sit underneath every AI as the deterministic control point and
   the system of record, and the more agents run through us the better our risk
   scoring gets. That data compounds and cannot be copied by shipping a feature.
8. **Compliance as a wedge.** Generated SOC2 / ISO 42001 / NIST / EU AI Act
   evidence from live controls. Procurement-ready, not a binder.
9. **Business model.** Free discovery scan to land, per-governed-agent (or
   per-app) to grow, enterprise control plane plus compliance to expand.
   Consulting-led 12-month program, $60k Year 1, to start.
10. **Why us.** Deep, working product, not a wrapper. Built by operators. We tell
    you exactly where we are (the honesty is the moat).
11. **Traction / proof.** The live demo, the design partners, the quantified
    before/after from the first scans. (Fill as you land them.)
12. **The ask.** What you are raising or selling, and the single next step.

### The closing line (memorize)
"AI's capabilities are astonishing. The companies that win the next decade are the
ones that can use that power without getting burned by it. OGIAM is how they do
that: harness the upside, govern the downside, and prove it."

---

## How to update this doc

As you run real outreach, replace the templates with the variants that actually
got replies, and fill slide 11 with real traction. The hook and the discovery
script change least; the proof slide changes most.
