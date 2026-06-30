# OGIAM demo runbook (flake-proof, rehearsable)

A repeatable 8-minute live demo on the real product, built so it cannot fall
flat in front of a prospect. The rule: never show an empty screen and never wait
on a cold route. Seed first, rehearse the path, keep a recorded fallback.

Live surfaces used (all behind login at https://wolfpack-instinct.vercel.app):
- Discover: `/admin/ai-surfaces`
- Govern: `/admin/ogiam`
- Assure: `/admin/ai-redteam`

---

## Pre-flight checklist (T-15 minutes, every time)

1. **Log in** to the demo account and confirm all three pages load (warming the
   routes so the first click in the meeting is instant, not a cold compile).
2. **Seed Discover.** On `/admin/ai-surfaces`, run a discovery scan over the demo
   fixture below so the inventory shows real, alarming content (ungoverned AI + a
   leaked key). Confirm the **Ungoverned** tile is non-zero and a `critical`-risk
   `api_key` row is visible. (Scanning the prospect's own code live is even
   stronger when you have it; the fixture is your guaranteed fallback.)
3. **Seed Assure.** On `/admin/ai-redteam`, click **Run red-team now** once.
   Confirm the headline reads 100% pass / 0 vulnerabilities and the category
   breakdown shows blocked/blocked across all four.
4. **Confirm Govern has data.** On `/admin/ogiam`, confirm the decisions ledger
   shows recorded decisions including at least one would-block. If empty, drive
   one adversarial assistant action first so the ledger has a blocked entry.
5. **Have the fallback ready:** a screen recording (or GIF) of each of the three
   beats, in a tab, so a network hiccup never stalls the story.

### The demo fixture (paste into the discovery scan)

A tiny "demo-app" the scanner reliably flags. Use clearly-fake placeholder keys
(the point is the shape, not a real secret). Example files:

- `app/ai.ts`: `import OpenAI from "openai";` and a hardcoded key assignment
  using a fake `sk-proj-` value about 40 characters long (no real secret).
- `app/agent.ts`: `import Anthropic from "@anthropic-ai/sdk";` plus a
  `fetch("https://api.anthropic.com/v1/messages", ...)` call.
- `app/util.ts`: a bare `fetch("https://api.openai.com/v1/chat", ...)` with no
  governance wrapper.

Expected result: 4-plus AI surfaces, at least one `critical` api_key, all marked
ungoverned. That is the alarm.

---

## The flow (8 minutes)

### 0. Frame (30s, no screen)
"Every company wants to put AI agents to work, and their security teams are
blocking it, because the moment AI can take actions you can't control what it
does or prove what it did. I'm going to show you both, on the real product."

### 1. Discover (2 min) -> `/admin/ai-surfaces`
- **Click:** the page is already seeded.
- **Say:** "First, you can't govern what you can't see. This scanned a codebase
  and found every place AI touches the system. Forty-some touchpoints, and look,
  two of them are leaking an API key. None of this was on anyone's map."
- **Point at:** the **Ungoverned** tile, then the `critical` api_key row.
- **The line that lands:** "This is the part that makes a CISO sit up. We can run
  this on your code and you'll see your own version of this screen."

### 2. Govern (2 min) -> `/admin/ogiam`
- **Say:** "Now watch what happens when an AI agent tries something dangerous.
  The model proposed an action. A deterministic policy, not another AI, decided,
  and it blocked it."
- **Point at:** a would-block decision row, the rule that fired, and the
  tamper-evident record.
- **The line:** "The model is probabilistic. Our governance is not. And here is
  the signed, ordered record an auditor would accept. AI proposes, we dispose,
  deterministically and provably."

### 3. Assure (1.5 min) -> `/admin/ai-redteam`
- **Click:** **Run red-team now** (it returns fast and deterministically).
- **Say:** "We don't ask you to trust the gate. We prove it. This just attacked
  your own gate with the known AI attack classes, secret exfiltration, prompt
  injection into actions, privilege escalation, and it blocked every one. This
  runs on a schedule, so a regression is caught before a client ever hits it."
- **Point at:** 100% pass, 0 vulnerabilities, the category breakdown.

### 4. Comply (45s, teaser)
- **Say:** "All of this becomes the evidence your auditor asks for. We map these
  controls to SOC2, ISO 42001, NIST AI RMF, and the EU AI Act and generate a
  coverage report from the live data, not a binder. Governance stops being a deck
  and becomes a signed receipt." (Show the coverage view if it is live; otherwise
  describe it, honestly, as shipping.)

### 5. Close (1 min)
- **The offer:** "Most teams start with a 12-month AI governance program: $60k
  all-in, discovery, design, deployment, and a year of continuous assurance.
  Discovery and design are free if you commit to the year."
- **The ask (this is the close):** "The fastest next step is to let us run the
  discovery scan on your codebase. You'll see your own version of that first
  screen, your ungoverned AI and any leaked keys, in a few minutes. Can we get
  read access to a repo and put a real number in front of you by Friday?"

---

## If it breaks (the fallback)

| Symptom | Do this |
|---|---|
| A page is slow / spins | Switch to the recorded clip of that beat; narrate over it. Never wait live. |
| Discover looks empty | You skipped the seed. Switch to the recording; re-seed before the next demo. |
| Red-team button errors | Show the run history (already populated from the seed) instead of a live run. |
| Login bounced | Have a second, already-authenticated browser profile open as a hot spare. |

Golden rule: the story is the asset, not the live infra. If anything stalls for
more than three seconds, cut to the recording and keep talking. Rehearse the
whole path twice before any real meeting.

---

## How to update this runbook

When a new beat UI ships (the policy simulator "Prove" beat, the compliance
coverage view), add it as a numbered step with the same shape: Click / Say /
Point at / The line. Keep the whole flow under ten minutes; cut older beats to a
sentence before letting it grow.
