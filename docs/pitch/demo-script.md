# OGIAM live demo script

A repeatable, investor-ready demo. It is built as five beats that walk a viewer
from fear to relief. Each beat is self-contained, so as we ship new capabilities
we add or swap a beat without rewriting the flow. Keep the whole thing under ten
minutes; the goal is to make them lean forward, not to teach the architecture.

How to update this doc: every new capability gets a beat with the same four
lines (Say / Show / The aha / Backup if they go technical). Mark each beat UI or
API so you know what is click-through vs script-driven today.

---

## The frame (say this first, 20 seconds)

"Every company wants to put AI agents to work. They can't, because the moment AI
can take actions in your systems, you can't control what it does and you can't
prove what it did. OGIAM is the layer that fixes both. AI proposes, we
deterministically decide, execute inside your own access, and record every action
in a way that can't be faked. Let me show you, on a real system."

Then run the beats in order.

---

## Beat 1 - Discover (the fear). UI + API

- **Say:** "First, you can't govern what you can't see. Most orgs have no idea how
  much AI is already wired into their systems."
- **Show:** Run the shadow-AI discovery scan over a codebase. It surfaces every
  LLM SDK call, every model-provider endpoint, and any AI keys, and flags the
  ungoverned ones. (`POST /api/admin/ai-surfaces/scan`, results on the AI Surface
  Inventory.)
- **The aha:** "Here are 40-some places AI touches your systems, and two of them
  are leaking an API key. None of this was on anyone's map."
- **Backup (technical):** precision-first, signature-grade detectors, no noisy
  regex; the inventory is a workspace-scoped time series so the ungoverned-AI gap
  is tracked, not just snapshotted.

## Beat 2 - Govern (the relief). UI

- **Say:** "Now watch what happens when an agent tries something dangerous."
- **Show:** Trigger an agent action that should be blocked (a high-risk mutation,
  or an action carrying a secret). The OGIAM gate denies or escalates it in real
  time, and the decision lands in the tamper-evident ledger. (`/admin/agents`,
  `/admin/ogiam` decisions explorer.)
- **The aha:** "The model proposed it. A deterministic policy, not another AI,
  decided. And here is the signed, hash-chained record an auditor would accept."
- **Backup:** agents are first-class IAM principals with a human owner; they act
  on behalf of that owner, capped by the owner's own access, never beyond it.
  Fail-closed: if an action can't be recorded, it doesn't run.

## Beat 3 - Prove before you enforce (the wow). API today, UI on roadmap

- **Say:** "The hardest part of governance is not breaking the business when you
  turn a rule on. So we let you test a policy against your real history first."
- **Show:** The policy simulator replays a candidate enforcement rule over the
  last 30 days of real recorded AI decisions and reports exactly what it would
  have blocked, by capability and by agent. (`POST /api/admin/ogiam/simulate`.)
- **The aha:** "You test an AI governance change against real traffic before you
  flip it, the way you'd dry-run a firewall rule. Almost nobody can do this,
  because it needs the decision history we already keep."
- **Backup:** the gate runs in monitor mode by default, recording every would-be
  decision; the simulator mines that shadow ledger. Enforcement is a per-capability
  posture you graduate on your own schedule.

## Beat 4 - Assure continuously (the proof). API + cron

- **Say:** "We don't ask you to trust that the gate works. We prove it, on a
  schedule."
- **Show:** The continuous red-team runs an adversarial corpus (secret exfil,
  prompt-injection-into-action, privilege escalation, destructive actions) against
  your own gate every few hours. Show the standing result: 100 percent blocked.
  (`/api/cron/ai-redteam`, history at `/api/admin/ai-redteam/run`.)
- **The aha:** "Every six hours we attack your gate with the known AI attack
  classes and show you it held. If a policy ever regresses, this catches it before
  a client does."
- **Backup:** the corpus maps to the OWASP LLM Top 10; the runner exercises the
  real gate path, so it proves the live system, not a copy. It is deterministic
  and offline, so running it constantly is free.

## Beat 5 - Comply (the close). Roadmap, partially available

- **Say:** "Finally, all of this becomes the evidence your auditor and your
  customers ask for."
- **Show:** The audit ledger and posture, mapped to the frameworks (SOC2, ISO
  42001, NIST AI RMF, EU AI Act). Generate a signed evidence pack.
- **The aha:** "Governance stops being a slide deck and becomes a signed receipt.
  That is what shortens an enterprise security review from weeks to days."
- **Backup:** hash-chained, append-only, crypto-agile signing; every decision
  names the rule that fired, so each entry is explainable and reproducible.

---

## The two short versions

**30-second walk-and-talk (no screen):** "We scan your systems and show you every
place AI is already running, including the ungoverned ones. Then we put a
deterministic gate in front of every AI action: it allows, blocks, or sends it to
a human, and records all of it in a tamper-evident ledger. You can test a policy
against your real history before enforcing it, and we continuously attack your own
gate to prove it holds. The result: you can finally deploy AI agents and prove to
anyone exactly what they did."

**The 3-minute deep-dive (for a technical investor):** run beats 1, 2, and 3 live,
then say: "The moat isn't any single feature. It's that we sit underneath all of
it as the deterministic control point and the system of record, and the more
agents run through us, the better our risk scoring gets. That data compounds and
can't be copied by shipping a feature."

---

## Pre-demo checklist

- A workspace with seeded agents and a populated decision ledger (so beat 3 has
  real history to simulate over).
- A target codebase with a planted AI key for beat 1.
- The red-team history showing a clean run for beat 4.
- A fallback recording of each beat in case live infra hiccups.

## The product surfaces the demo touches

- UI today: `/admin/agents` (agent roster + detail + action trail),
  `/admin/ogiam` (decision explorer + gate self-test), `/admin/platform-scans`.
- API today (UI is the next slice): AI Surface Inventory + scan, MCP scan,
  AI-code review, policy simulator, enforce posture, continuous red-team. When a
  UI ships for one of these, move its beat from "API" to "UI" here.
