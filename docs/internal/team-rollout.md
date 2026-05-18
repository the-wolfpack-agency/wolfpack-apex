---
title: Instinct internal rollout — Wolfpack team
audience: Hoxsie + Nick (CTO)
last-updated: 2026-05-18
---

# Instinct internal rollout — Wolfpack team

A concise, practical plan for getting every Wolfpack teammate using Instinct as their daily-driver assistant. Designed so the slowest user (Alicia) succeeds; everyone else follows.

The core principle: each user gets a **starting kit of 3-6 prompts** they can use day one. Power users grow into the rest naturally. Non-tech users who don't see daily value within a week will stop using anything; design for them.

---

## Per-user starting kits

### Hoxsie (CEO) — power user, all features

Starting prompts:

1. `briefing`
2. `what is on my calendar this week`
3. `top 3 deals` (CRM)
4. `what's our revenue this quarter`
5. `find emails from <client>`

Week 2 additions: OKR tracker (`/goals`), knowledge & memory (`what do we know about <X>`), people search (`who is <X>`).

Style: mobile parity matters most — Hoxsie uses Instinct on travel + pre-meetings.

---

### Max — power user, tech savvy

Starting prompts:

1. `briefing`
2. `what PRs are open in <repo>`
3. `failed CI in <repo>`
4. `create OKR for <thing>`
5. `<account>'s opportunities`
6. Drag a file into chat to add it to the knowledge base

Day-one access: Settings → Integrations (connect every system), Brain uploads (`/brain`), Admin Insights (`/admin/insights`) for the unmet-intent backlog.

Max becomes the alpha tester. Whatever he stumbles on is a real bug.

---

### Jorge — VP, client-facing

Highest-value persona for Instinct. His job is meetings + relationships + follow-ups, and Instinct compresses all three.

Starting prompts:

1. `briefing` — daily prep
2. `am I free Thursday at 2pm`
3. `<account>'s opportunities`
4. `find emails from <person>` — context before a call
5. `schedule a meeting with <person> about <topic> friday at 2pm`

Week 2 additions: Meetings page (`/meetings/feeds`) for Plaud transcripts, pre-brief panel inside the briefing widget, `what do we know about <account>` for Brain context.

His win: the 15 minutes before each client call. One prompt → deal state + recent email thread + last meeting summary.

---

### Alicia — Project Manager, self-described not tech-savvy

The litmus test of the whole rollout. If she succeeds, everyone else will.

Starting prompts (only three — keep it minimal):

1. `briefing`
2. `what is on my calendar today`
3. `create task to <thing> by friday`

Week 3 additions (NOT day one): `find emails from <person>`, `what do we know about <account>`.

Critical for success:

- Printed cheat sheet on her desk.
- 10-minute screen-share kickoff with Hoxsie or Nick — do not skip.
- One prompt that works every day for two weeks beats five prompts she's afraid to try once.

---

### Ashley — Project Manager

Default: same kit as Alicia.

If Ashley turns out to be tech-savvy, skip the kickoff call and let her self-onboard with the cheat sheet plus the help channel. If unknown, treat as not-tech-savvy and give her the same hand-holding as Alicia.

---

### Meghan — Designer

Starting prompts:

1. `briefing`
2. `what is on my calendar today`
3. `find emails from <client>`

Week 2 additions: Bulletin boards (`/bulletin`) for visual coordination, Brand asset Brain uploads.

Style: Meghan uses Instinct less than her visual surfaces. Don't force chat on her. Bulletin and Brain uploads are her win.

---

## Cross-team onboarding artifacts

Four artifacts cover the whole team. No long manuals.

### 1. Cheat sheet (printed, one per person)

A 4x6 index card taped to the monitor. Front: their 3-5 starting prompts in big type. Back: link to the assistant URL plus the help Slack channel.

Effort: half a day in Figma, $20 to print at FedEx.

### 2. Per-user kickoff call (10 min each)

Sit with each person individually. Screen-share Instinct. Type the first prompt for them. Watch them type the second. Answer questions.

Order: Max → Jorge → Hoxsie → Meghan → Alicia → Ashley. Max first so he's already in the help channel answering questions by the time others start.

Effort: ~1 hour total. Do not skip this for the PMs.

### 3. Slack channel: `#instinct-help`

One channel for screenshots of weird answers or "how do I do X" questions. Nick or Max responds same-day. Single most important onboarding asset. Without it, confused users go silent and stop using the product.

### 4. "What's possible" doc (one Notion page)

A single internal page listing every prompt category with one example each, grouped by role. The source-of-truth file already exists in the repo at `docs/explainers/assistant-prompts.md` — just need to publish it as a Notion page Hoxsie can share.

---

## Improvements to ship before rollout

Three changes that measurably raise non-tech-user success rates. ~1 day combined.

### 1. First-time welcome flow

On first visit to `/assistant`, a one-time modal: "Hi <name>, I'm Instinct. Try one of these first prompts." Three chips personalized by role. Dismissable, persisted to localStorage.

Effort: ~3 hours. Big payoff because it lands a successful first prompt for Alicia before she has time to feel lost.

### 2. Hover tooltips on starter chips

`briefing` is just a word right now. A tooltip on hover explaining what it does ("Your morning summary: schedule, emails, action items") removes the guesswork. Same for every chip.

Effort: ~2 hours. Add a `description` field to each chip, render as `title=` attribute.

### 3. Friendlier "I don't understand" response

When the assistant falls through to its low-confidence answer, replace the generic message with: "I'm not sure how to help with that yet. Try one of these instead: [3 chips tailored to the user's role]." Turns a miss into a redirect.

Effort: ~3 hours. Threads role context into the chat() fallback path.

---

## Rollout sequence

**Week 1:**

- Ship the three improvements above.
- Print cheat sheets.
- Kickoff calls in order: Max → Jorge → Hoxsie → Meghan → Alicia → Ashley.

**Week 2:**

- 1:1 check-ins with each person. Ask what's working, what's confusing, what they wish it did.
- Iterate on whatever the PMs couldn't get to work.

**Week 3:**

- Layer in deep features per the per-user plan.
- Start using internal usage as a proof point with inbound prospects.

---

## What NOT to do

- **Don't write a long user manual.** Nobody reads them. Cheat sheet + 10-min kickoff + Slack channel covers it.
- **Don't force the PMs to learn CRM, GitHub, or admin pages.** Those aren't their workflow. Force-feeding features hurts adoption.
- **Don't track adoption with a dashboard yet.** Too early. Track conversationally at the all-hands.
- **Don't include Sites editor in any starting kit.** External site builds are Max-only.

---

## The one thing to get right

Personally kickoff Alicia and Ashley. Don't leave the room until each one has successfully sent a prompt and gotten a useful answer. That moment is the difference between a tool the team uses and a tool that only Hoxsie and Max touch. Everything else is replaceable.

---

## Open questions

- Ashley's tech-savviness — default to not-tech-savvy until confirmed.
- Should Sites editor (`/sites`) be hidden from the team nav entirely, or stay accessible at the URL for ad-hoc use? Currently leaving accessible.
- Cheat sheet print run — how many copies and what size paper does Hoxsie want.
