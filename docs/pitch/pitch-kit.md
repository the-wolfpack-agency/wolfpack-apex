# OGIAM pitch kit

Everything to get the point across to any investor, fast. You are a deep
engineer; your instinct is to explain the architecture. Investors buy the
outcome and the fear, not the architecture. This kit translates your depth into
their language. Architecture is your backup for when they ask "how," never your
opener.

How to update this doc: when we ship a capability, add it to "The products in
plain language" and, if it changes the story, to the talking points. Keep the
one-liners one line.

---

## The thesis in one breath

AI is the most powerful tool we've ever built, and it is probabilistic, which
makes wiring it straight into your systems dangerous: it can be manipulated, leak
data, take destructive actions, and leave you unable to prove what it did. OGIAM
is the deterministic control layer between AI and your software. AI proposes;
OGIAM decides, executes within your access, and proves every action. We let an
organization use AI's power while staying safe from its dangers.

## The logline (memorize this)

**"OGIAM is the control plane for AI agents. AI proposes, we deterministically
decide, execute within your own access, and prove every action. We're the IAM and
assurance layer that lets enterprises actually deploy AI."**

---

## Elevator pitches by length

**10 seconds:** "Companies want to deploy AI agents but can't, because they can't
control or prove what the AI does. OGIAM is the deterministic gate and audit layer
that makes it safe. Think IAM, but for AI."

**30 seconds:** "Every enterprise is racing to put AI agents to work, and their
security teams are blocking it, because once AI can take actions, you can't
control it or prove what it did. OGIAM is the layer that fixes both: a
deterministic policy gate in front of every AI action, and a tamper-evident record
of all of it. We give AI agents identities and least-privilege like employees, and
we continuously prove the controls hold. It's the layer that turns AI from a risk
your CISO blocks into a capability you can actually ship."

**60 seconds:** the 30-second version, then: "There are two products. OGIAM IAM
governs the AI: the gate, the agent identities, the tamper-evident audit, and a
simulator that lets you test a policy against your real history before you enforce
it. OGIAM QA assures the AI and the software around it: it runs autonomous QA and
penetration testing, scans for ungoverned AI and leaked keys, scans the new MCP
attack surface, governs AI-written code before it merges, and continuously
red-teams your own gate. The wedge is dead simple: we scan your org for free and
show you every place AI is already running ungoverned. That opens the door; the
governance platform is the expansion. And the more agents run through us, the
smarter our risk scoring gets, which is a data moat a feature can't copy."

---

## Elevator pitches by investor type

**Security / infra investor** (lead with the threat and the proof): "Coupling your
software to an LLM is a new, ungoverned attack surface: prompt injection, data
exfiltration, excessive agency, supply-chain risk through tools and MCP. OGIAM is
the deterministic policy enforcement point and tamper-evident system of record for
every AI action, plus continuous adversarial assurance that it holds. It's the
control plane CISOs need before they approve agents, and it maps straight to SOC2,
ISO 42001, and the EU AI Act."

**Enterprise SaaS / generalist** (lead with buyer pain and the business model):
"AI agents are the next workforce, and right now there's no manager for them. We
onboard AI agents like employees: identity, role, least-privilege, audit. We land
with a free scan that shows a company its ungoverned AI, then expand into the
governance platform, priced per agent. It's a control plane, so it's sticky, and
usage compounds the data that makes it better. Land-and-expand with strong net
retention in a market that's inevitable."

**Deep technical / thesis-driven VC** (lead with the architecture moat and why
wrappers lose): "Most AI startups are wrappers: a prompt plus an API call plus a
UI. Easy to copy, no moat, and each one makes AI more dangerous because it's one
more ungoverned place AI touches systems. We go the other direction: we're the
infrastructure underneath the AI. A deterministic policy gate, a hash-chained
signed ledger, agent identity as a first-class principal, and a cross-execution
learning flywheel. The model is probabilistic; our governance is deterministic and
reproducible. As wrappers proliferate, demand for us grows: every new AI surface
is a new thing we discover and govern. The wrappers are our market, not our
competition."

---

## The analogies that land (pick the one that fits the room)

- **"Okta / IAM for AI agents."** Agents get identities, roles, least-privilege,
  and an audit trail, exactly like employees. (Best for enterprise and security.)
- **"A firewall for AI actions."** Every action an AI takes passes a deterministic
  policy check before it executes. (Best for infra.)
- **"The flight recorder and air traffic control for AI."** Provable record plus
  real-time control. (Best for a vivid, non-technical room.)
- **"Brakes and a seatbelt for a Ferrari engine."** AI is the engine; without
  brakes you can't actually use the power. We're what lets you drive it fast and
  safely. (Best for the why-this-matters moment.)

---

## The products in plain language

For each: the one-liner, the plain "what and why," and the technical backup.

### OGIAM IAM (govern the AI)

- **The gate.** One-liner: "Every AI action is checked against your rules before it
  runs." Plain: an AI suggests an action; a deterministic policy, not another AI,
  decides allow, block, transform, or send-to-a-human, and records it. Backup:
  pure, reproducible decision function; the rule that fired is always named.
- **Agent identity.** One-liner: "AI agents get IDs and permissions like
  employees." Plain: each agent has an owner, a role, and least-privilege; it can
  only do what its owner is allowed to do. Backup: standards-based identity,
  owner-bounded delegation, full lifecycle.
- **Tamper-evident audit.** One-liner: "A record of every AI action that can't be
  faked." Plain: a sealed, ordered log an auditor accepts; nothing lost. Backup:
  hash-chained, append-only, crypto-agile signing, fail-closed on unauditable.
- **Policy simulator.** One-liner: "Test an AI rule against your real history
  before you turn it on." Plain: see exactly what a new rule would have blocked
  over the last month, so you don't break the business. Backup: replays the shadow
  decision ledger.
- **Enforce posture.** One-liner: "Flip any rule from watch to block, per team, no
  code change." Plain: graduate governance on your own schedule. Backup:
  per-capability mode, every change audited.
- **Drift detection.** One-liner: "We notice when an agent's behavior changes."
  Plain: a baseline per agent; if it starts acting differently, you're alerted.
- **Shadow-AI discovery.** One-liner: "Find every place AI is already running,
  including the ungoverned ones." Plain: scan your code, surface AI usage and
  leaked keys. Backup: precision-first detectors, workspace-scoped inventory.

### OGIAM QA (assure the AI and the software)

- **Autonomous QA + pentest.** One-liner: "AI that tests your app like a user and
  an attacker." Plain: drives the real UI and probes for security holes, CWE-
  classified. Backup: precision-first detectors, ownership-gated targets.
- **MCP server scanner.** One-liner: "Scan the new MCP attack surface for the real
  attacks." Plain: tool-poisoning, supply-chain servers, secrets, unauthenticated
  endpoints, hidden-instruction tricks, without connecting to anything. Backup:
  static, config-only, registers into the AI inventory.
- **AI-code governance.** One-liner: "Gate AI-written code before it merges."
  Plain: scan an AI's diff for secrets, vulnerabilities, and exfiltration, and
  block or escalate. Backup: CWE-classified, deterministic verdict.
- **Continuous red-team.** One-liner: "We attack your own gate every few hours and
  prove it holds." Plain: standing adversarial assurance, mapped to the OWASP LLM
  Top 10. Backup: exercises the real gate path, deterministic and offline.

---

## Why the tool is awesome (the talking points)

1. **It's real and deep, not a wrapper.** A working product you can run today, not
   a deck. In a category full of slides, you show a live gate block an attack and
   hand over the signed receipt.
2. **It's the inevitable layer.** Every AI agent will need an identity, a gate, and
   an audit trail. We're building all three.
3. **It turns AI from a risk into a deployable asset.** We're the reason a CISO
   says yes. That is a budget unlock, not a nice-to-have.
4. **It's a control plane.** Sticky, high net retention, expands across an org,
   becomes a platform.
5. **It has a data moat.** The more agents run through the gate, the better the
   risk scoring gets. Compounding proprietary data a competitor can't copy by
   shipping a feature.
6. **It's compliance-ready.** Maps to SOC2, ISO 42001, NIST AI RMF, EU AI Act, so
   it accelerates enterprise procurement instead of slowing it.
7. **It's model and framework agnostic.** Switzerland. It survives the platform
   shifts that will kill the wrapper companies.
8. **Two products that reinforce each other.** Govern and assure, the same gate and
   ledger underneath both.

---

## The anti-wrapper thesis (your differentiator, say it with conviction)

"A wave of startups are building thin wrappers on top of the models: a clever
prompt, an API call, a UI. They look like products and they're easy to copy, and
here's the deeper point: every wrapper makes the AI problem worse, because it's one
more place AI is wired into a business with no governance. We looked at the
architecture, not the surface. The durable value isn't another thing that talks to
the model. It's the control plane that goes underneath every AI: the identity
layer, the deterministic gate, the system of record. That's infrastructure, and
infrastructure is where the moats and the multiples are. The wrappers aren't our
competition. They're our market. Every one of them is a new ungoverned AI surface
that we discover and govern."

---

## Objection handling

- **"Won't Microsoft or Anthropic just build this?"** They're racing on models;
  governance across all of them, neutrally, is not their focus, and a model vendor
  governing itself is a conflict an enterprise won't accept. We're the neutral,
  model-and-framework-agnostic system of record. Being multi-vendor is the wedge,
  not a weakness.
- **"Isn't this a feature, not a company?"** A control plane plus an audit
  system of record plus a compliance surface plus a data flywheel is a platform.
  IAM was once "a feature" too; it became Okta and SailPoint and CyberArk.
- **"AI to govern AI sounds circular."** That's the point of the design: the model
  only proposes; a deterministic policy decides. We don't trust an AI to police an
  AI. That's why the gate is reproducible and the record is tamper-evident.
- **"Is the market real yet?"** Security teams are actively blocking agent
  rollouts today, and the EU AI Act and ISO 42001 are landing. We're early, which
  is exactly when you take the category.
- **"How do you get the first customers?"** A free scan that shows a company its
  own ungoverned AI and leaked keys. It creates the alarm that starts the
  conversation, and the governance platform is the expansion.

---

## Engineer-to-investor translator (say this, not that)

You love the deep stuff. Investors need the outcome. Lead left-column-fear,
right-column-relief; keep the middle column in your pocket for when they ask how.

| Don't open with (engineer) | The thing it actually does | Say this (investor) |
|---|---|---|
| "deterministic policy gate with a hash-chained tamper-evident ledger" | checks + records every AI action unforgeably | "every AI action is checked against your rules and recorded in a way that can't be faked, so you can prove exactly what your AI did" |
| "agent identity as a first-class IAM principal with capability-scoped on-behalf delegation" | agents get scoped permissions tied to a human | "AI agents get IDs and permissions like employees, and can only do what their human owner is allowed to do" |
| "triple-write to Postgres, Qdrant, and Neo4j feeding a learning flywheel" | usage makes the product smarter and stickier | "the more it's used, the smarter and stickier it gets; that's our moat" |
| "fail-closed on unauditable in enforce mode" | if it can't be recorded, it doesn't happen | "if an action can't be safely recorded, we don't let it run; no silent, unaudited AI actions" |
| "precision-first signature-grade detectors, no noisy regex" | the findings are real, not false alarms | "we only flag the real risks, so your team trusts the output" |
| "OWASP LLM Top 10 corpus exercised against the live gate path" | we attack our own gate and prove it holds | "we continuously attack your own AI controls and prove they hold, so you're not trusting a promise" |
| "model-and-framework-agnostic control plane" | works with any AI vendor | "it works with any AI you use, so you're never locked in and you survive the next platform shift" |

The rule of three for any room: **the fear** (you can't control or prove what AI
does), **the relief** (we make AI's actions governed and provable), **the proof**
(here it is, live, with a signed receipt). Everything else is backup.

---

## The closing line

"AI's capabilities are astonishing. The companies that win the next decade will be
the ones that can actually use that power without getting burned by it. OGIAM is
how they do that: harness the upside, govern the downside, and prove it. We're
building the layer that makes enterprise AI safe enough to say yes to."
