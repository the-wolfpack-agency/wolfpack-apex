# Feature: Meeting + Microsoft Suite Insight Generator

**Status:** Brainstorm — captured for future implementation
**Date captured:** April 7, 2026
**Captured by:** Nick Homyk, CTO
**Related shipped work:** Plaud ingestion (commit `fe2a49a`), Plaud UI surface (commit `85f0bd5`)

---

## Why this combination is uniquely valuable

Microsoft 365 tells us what was **scheduled** and **written down**.
Plaud tells us what was actually **said**.

Almost every interesting insight lives in the **gap between those two**. Until both feeds are live in Instinct, none of these insights are possible — once both are live, most of them are nearly free to compute.

This is also the first integration in Instinct that gives us data the team **generates without trying**. Every other source (knowledge base, journal, feature requests) requires someone to type something. Calendar + meeting audio is passive — it just happens. That makes this the highest-leverage data source we have once both connections are real.

---

## Tier 1 — Insights that are basically free once both feeds exist

These need almost no new logic, just joins on data we already have.

### 1. "Said vs. Done" — meeting commitment tracking
- **Plaud says:** "I'll send the proposal by Friday"
- **MS Graph says:** no email matching that pattern was sent by Friday
- **Insight:** action items extracted from transcripts that have no follow-up evidence in calendar or email within their stated timeframe.
- **Why it matters:** the team's actual follow-through rate becomes a measurable thing instead of a feeling.

### 2. Meeting prep signal *(recommended first build)*
- **MS Graph says:** a meeting with `external@client.com` is on the calendar tomorrow at 10am
- **Plaud says:** the most recent call with that contact was 3 weeks ago and ended on "we'll circle back on pricing"
- **Insight:** morning briefing surfaces *"Tomorrow you're meeting Acme. Last call you committed to revised pricing — has it gone out?"*
- **Why it matters:** the briefing actually becomes intelligent instead of just listing events. Highest visible value to the team.

### 3. Stale relationship detection
- **MS Graph contacts** gives the people in the team's address books
- **Plaud transcripts** gives who's actually been talked to
- **Calendar** gives who's been scheduled with
- **Insight:** clients you have a relationship with but haven't talked to in 60+ days.
- **Why it's better than email-based detection:** captures the actual relationship cadence, not just inbox activity.

### 4. Topic decay
- Track topics extracted from transcripts over time, cross-referenced with calendar events on the same topics
- **Insight:** *"Q2 strategy was discussed in 4 meetings in March, 0 in April."* Either it shipped or it dropped — the learning loop flags both cases for the team to confirm.

---

## Tier 2 — Insights that need a little NLP but no LLM tokens

These can run on the doc-quality-gate sanitized text plus simple pattern matching. **Zero AI cost.**

### 5. Decision audit trail *(recommended second build)*
- Pattern-match for decision language in transcripts: *"we decided", "let's go with", "the call is", "I'm choosing"*
- Cross-link to the calendar event the decision was made in
- **Insight:** a queryable log of every decision the team has made, **with the exact context**. *"When did we decide to use Azure OpenAI for Instinct?"* → links to the meeting + transcript snippet + attendees + date.
- **Why it matters:** organizational memory that normally evaporates. Value compounds the longer the system runs.

### 6. Commitment ownership
- Extract *"I'll" / "I will" / "I can"* from transcripts, attribute to whoever was speaking (Plaud's diarization)
- **Insight:** per-person commitment count vs. completion rate.
- **Intent:** **for the person themselves to see**, not for performance management. *"I committed to 14 things in client calls last month, completed 9, 5 are still open."*

### 7. Meeting time vs. value heuristic
- Calendar gives meeting duration and attendee count
- Plaud transcripts give whether action items were actually generated
- **Insight:** *"meetings with 5+ attendees that produced 0 action items"* — a useful signal for when to convert a meeting to async. The classic "this could have been an email" detector, but data-driven.

### 8. Client sentiment drift
- Simple sentiment scoring (negative-word density, hedging language like *"concerned", "frustrated", "not sure"*) on transcripts of calls with the same external contact over time
- **Insight:** relationship temperature change.
- **Not for:** churn prediction. **For:** flagging *"the last call with Acme had 3x the hesitation language of the previous one"* so a human can decide whether it matters.

### 9. Knowledge gap detector
- Compare topics asked about in the Wolfpack Assistant against topics covered in meetings
- **Insight:** *"the team is asking the assistant about pricing strategy and there are no meetings or documents on it"* — points to a documentation/training gap.
- **Already aligns with:** the existing `knowledge.answer_not_found` analytics event.

---

## Tier 3 — Insights that need a small LLM call (but only when triggered)

These don't run on every transcript — they trigger when a Tier 1 or Tier 2 signal already says "this is interesting." That keeps token cost essentially zero.

### 10. Auto-generated weekly digest
- Once per week, produce a 5-bullet *"this is what the team actually talked about"* summary from the last 7 days of transcripts
- **Cost:** ~1 LLM call per week, $0.001 on GPT-4o-mini
- **Value:** replaces the weekly status meeting with a read-and-react document

### 11. Auto-extracted CRM updates
- For every transcript involving an external contact, extract *"what changed about the deal/relationship"* as structured fields (stage, next step, blocker)
- **Cost:** 1 cheap call per external-contact meeting
- **Value:** keeps a CRM-shaped record up to date without anyone manually entering it.
- **The actual killer feature** of this combination: most CRMs die because no one updates them.

### 12. Pre-meeting briefing
- 5 minutes before a calendar event with an external contact, fire a single tiny LLM call: *"Here's what we know about [contact] from prior meetings. Here are open commitments. Here's the topic of the upcoming meeting based on the invite title."*
- **Cost:** ~$0.002 per meeting briefed
- **Value:** walking into client calls already knowing where you left off, without manually reviewing notes

### 13. Meeting clustering
- Embed each transcript (already happening via Qdrant), then run periodic clustering to group meetings by **topic** automatically
- **Insight:** *"the team has had 12 meetings about authentication this quarter"* — emergent topic discovery without anyone tagging anything

---

## Tier 4 — Valuable but flagged for risk review

Technically possible. **Look carefully before shipping.**

### 14. Per-person speaking time / participation
- Diarization gives who spoke for how long
- **Could surface:** *"Alice spoke for 45% of the team meetings this month"*
- **Risk:** slides into surveillance territory fast. For internal Wolfpack-team-of-5 use it's probably fine and even useful (some people want to know if they're talking too much). For external client meetings it's invasive.
- **Default:** hide it; let users opt in for their own data only.

### 15. Topic-level mood across the company
- Aggregate sentiment by topic across all meetings: *"every time we discuss the pricing model the room sounds frustrated"*
- **Insight:** structural problems hiding in plain sight
- **Risk:** sentiment scoring is unreliable and could create false alarms about real people.
- **Default policy:** show in the briefing only if signal is very strong, otherwise stay quiet.

### 16. Question detection for external calls
- *"Every time a client asks about X, we mention Y"* — pattern mining client questions to find what to put in marketing/sales materials
- Genuinely useful for the agency business model
- **Risk:** depending on which clients consented to recording, aggregated analysis of their questions might create legal exposure. **Worth a real legal check** before shipping.

---

## Recommended build order

### First: Tier 1 #2 — meeting prep signal in the morning briefing

Reasoning:
- Most visible value to the team — every morning, every person, every day
- Zero LLM tokens (it's a join + a pattern search)
- Creates a feedback loop: if the briefing surfaces a stale commitment and the user marks it "done" or "no longer relevant," that's training data for the learning loop
- Makes the morning briefing stop being a list of facts and start being intelligent
- Exercises the entire pipeline (Plaud transcript → quality gate → PG → join with MS Graph → briefing render) — best end-to-end validation that the architecture works

### Second: Tier 2 #5 — decision audit trail

Reasoning:
- Answers questions the team will **constantly** ask later (*"when did we decide X?"*)
- Value compounds the longer the system runs
- Pure pattern matching, no LLM tokens
- Surfaces directly through the existing Wolfpack Assistant's Priority 3 retrieval (already shipped in commit `85f0bd5`)

### Hold off on
- **Anything in Tier 4** until Wolfpack's compliance / client agreements re: meeting recording consent are confirmed
- **Anything that calls an LLM on every transcript** (e.g., full structured extraction of every meeting). That's where token cost would actually matter, and the value-per-token is much lower than the on-trigger Tier 3 approach
- **A custom CRM schema** until the system has been exercised on real meetings for a few weeks and we know what fields we *actually* wish were extracted

---

## Cross-cutting principles (must apply to every insight when built)

- **Doc quality gate runs first.** No insight is generated from a transcript that hasn't passed the existing PII / security / compliance gate.
- **Per-user analytics on every insight delivery.** When an insight surfaces in a briefing and the user clicks it / dismisses it / marks it acted-on, fire `apex_events` so the learning loop can rank insights by usefulness over time.
- **Surface in the briefing, not in dashboards.** The briefing is read every morning. Dashboards are read once and then ignored. Passive delivery wins.
- **Org-shared by default, owner_user_id preserved.** Same as the existing Plaud ingestion: every team member can see every insight, but the owner is recorded so we can switch to scoped delivery later without re-ingesting.
- **Zero-token-first.** Tiers 1 and 2 are the default. Tier 3 only fires on triggered signals. Tier 4 is gated on legal review.
- **No insight is generated from data the system doesn't already have.** Every insight in this doc relies only on Plaud transcripts + MS Graph + the existing Wolfpack data stores. No new vendors, no new scopes.

---

## Prerequisites (none of this works without these)

1. `PLAUD_API_KEY` and `PLAUD_WEBHOOK_SECRET` set in production env
2. Plaud webhook registered in Plaud Developer Portal (endpoint: `/api/integrations/plaud/webhook`)
3. At least one team member's MS Graph connection live (per-user OAuth — already shipped in commit `c96129d`)
4. The org-level Plaud connection recorded via `POST /api/integrations/plaud { action: "connect" }`
5. At least ~5 meetings ingested (so the joins have something to find)

Once those are in place, **any item in Tier 1 or Tier 2 is a few hours of focused work** because the underlying data and infrastructure already exist.
