# Forcefield: the product brief (for the team and the CEO)

Internal enablement. How to understand, describe, and sell Forcefield with
confidence and WITHOUT overclaiming. In security sales, the vendor who states their
boundaries crisply is the one who gets trusted; hype gets torn apart in the security
review. Everything here is true today. No em dashes.

---

## 1. The one-liner

Forcefield shows you every automated visitor hitting your website, tells the good
bots from the bad by how they behave, welcomes the ones you want, and shuts out the
hostile ones automatically. It is safe to turn on from day one, and it never slows
down or breaks your site.

Say it even shorter: "We see the bots and AI agents hitting your site, and we stop
the bad ones without touching your real customers."

## 2. The problem that gets a room leaning in

Every website is hit around the clock by bots, scrapers, and now AI agents, probing
for a way in, stealing content, and testing logins. Most companies cannot see any
of it. And the AI-agent era is making it worse fast: software agents now browse,
scrape, and act on sites at machine speed, and almost nobody can tell a helpful
agent from a hostile one.

The hook question for a prospect: "Right now, agents are crawling your site. Can you
see them, and can you tell the good ones from the bad?" Almost always the answer is
no.

## 3. What it does, in four plain verbs

- **See** every automated visitor in one place: known crawlers, scrapers, probers,
  attackers.
- **Sort** friend from foe by how an agent BEHAVES, not the name it claims. A label
  is easy to fake; behavior is not.
- **Stop** the hostile ones the moment they show their hand, and welcome the ones
  that prove they are trustworthy.
- **Understand** each agent's whole path across your site and what it was after.
  Evidence, not an alert feed.

Plus a network effect: every site Forcefield protects shares what it catches, so an
attacker caught anywhere in the network is stopped on your site on sight.

## 4. Why we win (how to answer "how are you different")

The market has two ends and nobody owns the middle, which is exactly where we sit:

- The **enterprise suites** (DataDome, Cloudflare Bot Management, HUMAN, Kasada) are
  powerful but cost $4,000 to $13,000+ a month, are usage-metered, quote-only, and
  heavy to deploy.
- The **developer tools** (AWS WAF Bot Control, Arcjet) are cheap but basic and
  usage-metered.

Our wedge, the four things to hammer:

1. **Predictable pricing that never bills you more when you are under attack.** The
   usage-metered vendors literally charge you for the attacker's traffic. We do not.
   This is the line that lands every time.
2. **AI-agent aware.** We are built for the new problem (software agents), not just
   old-school fraud bots.
3. **Safe to turn on.** Watch-first: it watches and reports before it ever blocks,
   so switching it on cannot surprise-block your real customers. And it fails open,
   so if our service ever hiccups, your site keeps serving. The enterprise suites
   cannot say that.
4. **You can see everything and we prove it.** A live dashboard of exactly who is
   hitting you, and a Trust Center that shows our security evidence from the running
   system, not a slide.

Price advantage to state plainly: we deliver managed, AI-agent-aware defense at 5x
to 50x less than the enterprise suites, with no surprise usage bills.

## 5. The deterministic story (our sharpest differentiator)

This is the part to get genuinely excited about, because it is both a safety story
and a cost/speed story, and almost no competitor can claim it.

**Forcefield's core is deterministic, not AI.** It decides what is hostile using
rules and behavior, the same way every time, not a black-box model guessing. That
means:

- **It is auditable and repeatable.** We can show a client exactly why any request
  was treated the way it was. No "the AI decided."
- **We deliberately sectioned the AI off from the product, and we PROVE it.** Any AI
  we use lives in our build and research lab, never in the live decision path, and
  we enforce that with an automated check that fails our build if a core ever tries
  to call a model. The AI helps us build and improve the rules; it never runs the
  product.
- **So we need far fewer AI compliances.** The heavy AI-governance regimes (ISO
  42001, the EU AI Act, NIST AI RMF) exist to govern probabilistic AI that makes
  decisions about people. Our product does not do that, so those regimes largely do
  not apply to it. We carry the normal, well-understood SaaS security controls, not
  the AI-specific gauntlet.

How the CEO can say it: "Our engine is deterministic, not AI. The AI is in our
factory, not in your traffic. That makes us auditable, keeps us out of the heavy
AI-regulation bucket, and means there is no model in the loop that could do
something unpredictable to your site."

## 6. How we keep you safe (the trust points)

- **Watch-first.** It never blocks anything until you turn enforcement on. You see
  what it WOULD block first.
- **Fail-open.** If our engine is ever slow or down, your site keeps serving. A
  Forcefield outage degrades protection, never your availability. This is a design
  guarantee, not a promise.
- **Deterministic + auditable.** Same input, same decision, every time, with a
  record.
- **Your data stays minimal.** We record request metadata and counts (what kind of
  automated client hit which path and what it tried), never page contents, never
  your visitors' identities.
- **Isolation + kill-switch.** Each client's data is walled off; each client has a
  key we can instantly revoke or rotate if it is ever compromised.

## 7. Compliance: what we verify ourselves, and the one thing we do not

Be precise here, it builds credibility:

- **What we continuously verify ourselves:** on every change, automated security
  scanning, code-level dataflow analysis, accessibility and quality checks, and
  end-to-end tests. A live readiness board grades the product from the real code. A
  live compliance report maps our controls (access control, encryption, isolation,
  a tamper-evident audit trail) to the SOC 2 / ISO frameworks, with the status
  derived from the running system, not asserted. We even run our own penetration-
  test-style boundary checks against the live service.
- **The one thing we do not self-issue:** an independent third-party penetration
  test and an external certification. That independence is the entire point of a
  cert, so it has to come from outside. Our aim is to make our evidence so complete
  that the external audit is a last-mile stamp, engaged when a client requires it.

The honest headline: **"aligned to the standards and continuously self-verified,
not yet certified."** Say exactly that. It is true, and it is stronger than a vague
"we are secure."

## 8. Objection handling (the questions a buyer's security team will ask)

- "Are you SOC 2 / ISO certified?" -> "Not yet. We are aligned and we continuously
  verify the controls from the running system, and we will complete the external
  audit when you need it. Here is our Trust Center and evidence."
- "Will it break or slow my site?" -> "No. It fails open, so if anything goes wrong
  it just gets out of the way and your site keeps serving. And it adds a thin,
  fast edge check."
- "Will it block my real customers?" -> "Not unless you turn blocking on, and even
  then it only blocks proven-hostile behavior. It watches first, so you see exactly
  what it would block before you enable it."
- "How are you different from Cloudflare or DataDome?" -> "Predictable per-site
  pricing that never charges you more under attack, built for AI agents, safe to
  turn on day one, and a fraction of their cost."
- "Where does our data go?" -> "We store request metadata and counts only, never
  page contents or visitor identities."
- "Is there AI making decisions about my traffic?" -> "No. The engine is
  deterministic. We keep AI out of the live decision path on purpose, and we enforce
  that in our build."
- "What does it cost?" -> see the cheat sheet below.

## 9. Pricing cheat sheet (recommended, validate before quoting)

Flat per site, never metered on attack traffic:

- Free (watch-only): see what is hitting your site. This is our growth engine, not a
  discount; it earns the right to the paid conversation.
- Starter: $99 per site per month.
- Growth: $349 per site per month (the common deal).
- Scale: $1,200 per site per month, adds SSO and an SLA.
- Enterprise: custom.

How to use these in a conversation (important):
- Do NOT lead with a low number. In security, a low price reads as a weak product.
  Lead with the value and the free trial; let them see the threat on their own site
  first, then the price is cheap next to the risk.
- We list high and discount deliberately. Early customers get a Founding Customer
  deal (for example 50 percent off, locked for 12 months) in exchange for a
  reference. That gets us users WITHOUT anchoring the product to a low list price,
  which is painful to walk back later.
- Public site shows "Start free" and "Talk to us," not the paid numbers, until we
  have validated willingness to pay in real conversations.

The one-liner on price: "You pay a flat, predictable rate per site, and we never
charge you more when you are under attack, which is exactly when the metered vendors
bill you the most."

## 10. Say this / do not say this (keeps us credible)

Say:
- "Watch-first, safe to turn on day one." / "Fails open, never takes your site down."
- "Deterministic engine, AI kept out of the decision path." / "We need fewer AI
  compliances because the product is not AI."
- "Aligned and continuously self-verified, not yet certified."
- "We never bill you more for being under attack."

Do not say:
- "We block every attack" (we block proven-hostile behavior; we never claim 100%).
- "We are SOC 2 / ISO certified" (we are aligned, not certified).
- "It is impossible to get past us" (nobody can say that honestly).
- Any specific uptime number that is not in the signed SLA.

Confident honesty is the pitch. In security, that is what closes.

## 11. The boundaries today, and what we are closing (so "not yet" becomes "yes")

Every honest boundary is a build target. Say the boundary with the roadmap attached;
it reads as momentum, not weakness.

| Boundary a buyer may hear | Honest line today | What closes it (and who) |
|---|---|---|
| Not SOC 2 / ISO certified | "Aligned and self-verified; audit when you need it" | The external audit. Our evidence pack makes it last-mile. (External) |
| No published uptime SLA number | "Fail-open, so our uptime never affects yours" | A public status page + uptime monitor, then a committed SLA number. (Buildable) |
| Isolation is enforced in the app today | "Tenant-scoped, backed by a build-failing guardrail" | DB-level row-level security as defense-in-depth. (Buildable, with a DB cycle) |
| Enforcement verified in code, not yet end-to-end on a live client edge | "Watch-first; you enable and verify blocking" | An automated end-to-end enforce check on a deployed shim. (Buildable) |
| We do use some AI (operator aids) | "AI is in our factory, never your traffic; proven by a build check" | A per-deployment switch to run with zero AI touchpoints. (Buildable) |
| Shared threat intelligence | "We share CAUGHT-ATTACKER fingerprints, never your data or traffic" | A clear opt-out + the data-sharing boundary in writing. (Buildable) |

None of these are reasons to wait: the deterministic product is sellable today on
watch-first, and each row above is a concrete way to retire an objection and harden
the tool. We turn negatives into roadmap and then into shipped features.

## 12. Proof to put in front of a prospect

- The live protection panel on ogiam.com/forcefield (real numbers from the network).
- A dashboard walk-through scoped to their own site after a 10-minute setup.
- The Trust Center (our security and compliance posture, read from the live system).
- "Turn it on in watch-only and we will show you, in a day, exactly which agents are
  already on your site." That demo sells itself.
