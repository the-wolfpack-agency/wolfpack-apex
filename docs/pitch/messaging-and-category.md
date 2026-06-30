# Messaging and category

The canonical language for what OGIAM / Wolfpack Instinct is, written so every
seller, partner, and page says the same thing. This is the source of truth for
positioning words. Pairs with pitch-kit.md (the full pitch) and
outreach-and-deck.md (the channels). Where this doc and a client-facing surface
disagree, fix the surface to match this.

No em dashes anywhere (house style). Never name a competitor in client copy.

---

## The canonical one-liner (use verbatim)

> "OGIAM is the authorization gate and system of record for AI actions. The AI
> proposes, a deterministic policy decides, and every decision is written to a
> record that cannot be faked."

That is the line. It survives any room because it is literally what the product
does. When you have ten seconds, say the first sentence and stop.

---

## The category to own

We are defining a category, not slotting into one. The phrase to repeat until it
sticks is:

> **the authorization gate for AI actions**

with its companion framing:

> **the system of record for what your AI did**

Say these two together. The first is the control (what is allowed), the second
is the proof (what happened). Owning both halves is the whole point: most of the
market argues about the control and forgets the record.

Avoid drifting into borrowed labels ("AI guardrails," "AI firewall,"
"observability"). Use an analogy only as a bridge for a non-technical room (see
the analogy list in pitch-kit.md), then come back to the category words. The
analogy explains; the category is what we want them to remember and repeat.

---

## The message house (three pillars)

Everything we say hangs off three pillars. Each has a name, a promise, and the
one sentence that proves it.

### Gate
- **Promise:** every AI action is checked against your rules before it runs.
- **Proof:** a pure-function policy, not another model, decides allow, redact,
  escalate to a human, or deny, and the rule that fired is always named.

### Ledger
- **Promise:** you can prove exactly what your AI did, and nobody can rewrite it.
- **Proof:** every decision is appended to a hash-chained, tamper-evident record;
  if a decision cannot be recorded, the action does not run.

### Evidence
- **Promise:** your compliance story is generated from live controls, not
  assembled in a binder the week before the audit.
- **Proof:** the gate and ledger produce a coverage view mapped to SOC2, ISO
  42001, NIST AI RMF, and the EU AI Act, derived from real decisions, not claims.

The wedge that opens the conversation sits in front of all three: a free,
read-only shadow-AI scan that inventories where AI is already running in a
client's systems and how much of it is ungoverned. The scan creates the alarm;
the three pillars are the answer.

---

## The honest differentiation (say this with conviction)

Most "AI guardrails" are probabilistic: a second model, or a classifier, looks at
a prompt or an output and guesses whether it is safe. A guess is not a control. It
cannot be reproduced, it cannot be audited, and it fails in ways you cannot
predict or explain to a regulator. When the thing judging the AI is itself an AI,
you have not added governance, you have added another probabilistic surface to
worry about.

OGIAM goes the other way. The model only proposes. The decision is made by a
deterministic, pure-function policy: same input, same verdict, every time, with
the exact rule that fired named in the record. That decision is then written to a
hash-chained, tamper-evident ledger, so the question "what did your AI do, and can
you prove it" has a real answer instead of a shrug. Deterministic decision plus
unforgeable record is the difference between a control you can stand behind in an
audit and a guess you are hoping holds. That is the line a probabilistic guardrail
cannot cross, by construction.

---

## Do and don't (the honesty guardrails)

These exist because the honesty is the moat. One overclaim that a technical buyer
catches costs more trust than ten accurate claims earn. Hold the line.

### Do
- Say "deterministic policy decides" and "tamper-evident, hash-chained record."
  Those are true and they are the differentiator.
- Say "monitor by default, enforce on your schedule." We watch first; the customer
  graduates rules from observe to block when they are ready.
- Say "quantum-migration-ready" and "crypto-agile." The signing layer is built to
  swap algorithms; post-quantum slots are reserved.
- Say "decision-support evidence" for compliance. We accelerate the audit; we do
  not issue the certificate.
- Say "currently deployed with a single primary tenant; multi-tenant by design."
  Be precise about today versus the architecture.
- Say "the free scan is read-only and inventories your AI surface." It looks; it
  does not change anything.

### Don't
- Don't say "quantum-safe today" or imply post-quantum signing is live. It is a
  reserved slot that throws today.
- Don't say "SOC2 certified," "compliant," or "audit-proof." We generate evidence
  that supports an audit; we are not the auditor and we do not certify.
- Don't say "blocks all attacks," "guarantees," "unhackable," or "100% coverage."
  Continuous red-team proves the gate holds against a known corpus; it is
  assurance, not a guarantee.
- Don't announce MFA on admin as shipped. It is a pre-release checklist item.
- Don't claim the product replaces a human reviewer. Escalate-to-human is a
  first-class outcome of the gate, not a thing we removed.
- Don't name a competitor, ever, in any client-facing material.
- Don't imply the model makes the security decision. The model proposes; the
  deterministic policy decides. Getting this backwards undoes the whole pitch.
