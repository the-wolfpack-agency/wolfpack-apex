# Instinct Pitch Deck Outline

> 14 slides, paced for a 20-30 minute in-room delivery with 10 minutes for
> Q&A. Use this as a Keynote / Slides skeleton. Speaker notes are below
> each slide.

---

## Slide 1: Title

> **Wolfpack Instinct**
> *The integration layer your stack was missing.*
>
> [Wolfpack logo top-right]

**Speaker notes:** Land in 15 seconds. "We are going to show you a tool we
have been running internally for months. It is in production. Everything
you see today is live, not a demo built for this meeting. By the end of
the next 30 minutes you will know whether you want to try it on your next
engagement."

---

## Slide 2: The problem (the cost of NOT having this)

> **Your team uses 14 tools a day.**
>
> * Calendar, mail, tasks, CRM, accounting, docs, chat.
> * Each tool is a tab, a context switch, a search bar.
> * Each integration project takes a quarter.
> * Each new field in your CRM means a ticket to your dev team.

**Speaker notes:** Do not pitch yet. Just stack up what they already feel.
Ask: "How long is your team's average daily app-switch count?" Let them
answer. Whatever they say is enough.

---

## Slide 3: The pitch in one sentence

> Instinct is a chat-first agent that lives inside your tenant, speaks to
> every tool in your stack, learns what your team types, and ships new
> capabilities weekly.

**Speaker notes:** Read it slowly. Pause. Then immediately go to demo.

---

## Slide 4: Demo, part 1 (the morning glance) [LIVE]

> [Switch to live Instinct in the chat window.]
>
> Type: `briefing`

**Speaker notes:** Show the widget. Greeting, schedule, action items, pre-
brief picker. "This is one prompt. Six tabs of work in one panel. Open it
once at 8am, you have what you would have spent 20 minutes assembling."

---

## Slide 5: Demo, part 2 (the integration story) [LIVE]

> [Continue live demo.]
>
> 1. Type `find the deal for Acme` — show CRM lookup
> 2. Type `create a $50k deal with Acme` — show describe-driven form
> 3. Hover over a Salesforce custom field in the form

**Speaker notes:** The key line: "When your Salesforce admin adds a
required field tomorrow morning, this form picks it up that day. No
redeploy, no ticket to me. The form mirrors your schema, not mine."

---

## Slide 6: Demo, part 3 (the cross-tool story) [LIVE]

> [Continue live demo.]
>
> 1. Type `find emails to hoxsie about the proposal`
> 2. Click one of the result rows — opens Outlook
> 3. Type `create task to follow up next Tuesday`
> 4. Show the To-Do list dropdown, submit

**Speaker notes:** Land: "One chat surface, three tools, zero app
switching. Your team learns this in five minutes. Your slowest hire is
faster than your fastest power user today."

---

## Slide 7: The moat (what they cannot get elsewhere)

> **Three things only Instinct does:**
>
> 1. **Lives in your tenant.** Your OAuth, your audit log, your data
>    boundary.
> 2. **Deterministic-first.** Most prompts resolve without an AI model
>    call. Costs bounded, behavior auditable.
> 3. **Self-improving.** Every unmet prompt logged, ranked, built next.

**Speaker notes:** "ChatGPT cannot do these three. Operator cannot do them.
Microsoft Copilot cannot do them. And the AI labs structurally will not
build them, because it would compete with their enterprise sales motion.
We can, because we are not selling AI; we are selling the layer that makes
your AI useful."

---

## Slide 8: Demo, part 4 (the learning loop) [LIVE]

> [Open `/admin/insights`.]

**Speaker notes:** Show all three feeds. The unmet-intents backlog is the
moment of "oh." Land: "This is your team's actual vocabulary. Ranked by
how many people typed each. No survey, no guessing. Whatever is at the top
becomes a widget next week."

---

## Slide 9: Demo, part 5 (the autonomy layer) [LIVE]

> [Open Slack, show the integration-health alert.]

**Speaker notes:** "At 5am UTC today, this system detected a Salesforce
token expiry, alerted our channel, fixed it, and re-verified before any
user got a 500. Your operations team finds out about integration health
before users do."

---

## Slide 10: How Wolfpack deploys it

> **Engagement-bundled. Zero new invoice line.**
>
> * **Phase 0 (pre-engagement):** Vercel deploy, OAuth, your subdomain.
> * **Phase 1 (weeks 1-2):** Brain-ingest deliverables, connect CRM.
> * **Phase 2 (mid-engagement):** Show your team their dashboard.
> * **Phase 3 (end):** You see the data. Keep it or walk away.

**Speaker notes:** Emphasize Phase 3. "You are not making a buying
decision today. You are making it 8 weeks from now, on facts your team
will have generated. We just need permission to bundle it into the next
engagement."

---

## Slide 11: If you keep it

> **Three tiers, sized to your active user count.**
>
> * **Lite**: existing instance, MS 365 plus one CRM, hands-off support.
> * **Standard**: one new connector per quarter, dedicated Slack channel.
> * **Embedded**: Wolfpack engineer monthly, ships widgets against your
>   backlog.

**Speaker notes:** Do not quote price yet. "Pricing scales with usage. We
will land on a number once we see how your team uses it. The conversation
in week 8 is informed by data, not guesswork."

---

## Slide 12: If you walk away

> **You keep:**
>
> * The codebase, under an existing-license clause.
> * Your Brain content, exported as files.
> * The deployment runs as long as tokens are valid (months).
> * Every audit-log event, in your typed event stream.

**Speaker notes:** "No lock-in is not a slogan. It is in the contract. You
keep the data because it never left."

---

## Slide 13: What it would cost to build this internally

> | Capability | Internal build |
> |---|---|
> | Connector framework with OAuth refresh | 8-12 weeks senior eng |
> | Describe-driven form layer | 4 weeks |
> | Learning loop plus admin dashboard | 6 weeks |
> | Nightly health probe plus alerts | 2 weeks |
> | **Total** | **5-7 months, dedicated engineer** |

**Speaker notes:** "This is what it would take you to replicate. We did
this over six months on internal time. You get the output, not the
journey."

---

## Slide 14: Next step

> **Ask us to bundle Instinct into your next engagement.**
>
> No additional cost during the engagement period. Real data on your team's
> usage. Decision on retention happens at engagement close, on the
> evidence you have generated.
>
> [Contact: Nick Homyk, CTO. homyk@thewolfpack.agency]

**Speaker notes:** Do not ask for the close in the room. Ask for the next
meeting with their IT lead. "Who on your side approves OAuth scopes for
new tools? Let us get them a 15-minute scoping call this week."

---

## Closing tips for the room

* Lean on the live demo. Slides are scaffolding; the chat window is the
  product.
* If they say "what about ChatGPT," do NOT trash ChatGPT. Position
  Instinct as the layer that makes their existing AI investments useful.
* If they say "what about security," walk them through the OAuth scopes
  live. Show them the env vars are masked in logs.
* If they say "this sounds too good," show them the actual nightly alert
  from this morning. Real systems have real outages. Yours catches them.

## Slides NOT to make

* No "About Wolfpack" slide. They know who you are.
* No "Our Vision" slide. The product is the vision.
* No competitive grid. The comparison happens in the buyer's head; do not
  put a chart where you could put a live demo.
