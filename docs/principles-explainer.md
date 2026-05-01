# How Instinct uses this document

> Paste the section below into the **top of `Wolfpack_Operating_Principles_and_Scoreboard.docx`**. It explains, for Hoxsie and anyone else editing the doc, how Instinct turns these words into behavior across the team.

---

## How this document guides Instinct

### What you write here is the source of truth

This document is the canonical home for Wolfpack's operating principles. Everything Instinct does — the analytics it surfaces, the nudges it sends, the patterns it scores against — flows from what's written here. Instinct doesn't have its own opinions; it inherits them from this page.

When you change a principle here, you don't have to push code, file a ticket, or notify anyone. Instinct re-reads this document on a schedule (every two hours), notices what changed, and adjusts the entire platform accordingly.

### How it reads what you write

You write principles in plain English with a few simple markers so Instinct can parse them deterministically. The structure looks like this:

```
## Principle: Ship before perfect
**Domain:** code, comms
**Owner:** Hoxsie
**Effective:** 2026-05-01
**Scoreboard weight:** 3

We optimize for cycle time over polish on internal tools. The
client surface is the only place where perfection matters. If you're
spending more than half a day polishing something internal, stop
and ship.

**Signal:** PR cycle time from open → merge < 48h
**Signal:** No more than 2 reviewers requested per PR
**Counter-signal:** PRs sitting open >5 days without review comments
```

Only five things matter to the parser:

| Marker | Required? | What it does |
|---|---|---|
| `## Principle: <title>` | **Yes** | Starts a new principle. Title becomes its identity. |
| `**Domain:** ...` | Recommended | Comma-separated. Tells Instinct which surfaces (calendar, mail, code, etc.) to watch. Defaults to `cross_cutting`. |
| `**Owner:** ...` | Optional | Who's accountable for this principle. Surfaces on the scoreboard. |
| `**Effective:** ...` | Optional | Date the principle takes effect. Defaults to now. |
| `**Scoreboard weight:** 1–5` | Optional | How heavily this principle counts in the team scoreboard. Defaults to 1. |
| `**Signal:** ...` | Optional, repeatable | Positive observable patterns Instinct watches for. |
| `**Counter-signal:** ...` | Optional, repeatable | Anti-patterns Instinct flags when it sees them. |

Everything between the `**Domain:**` block and the `**Signal:**` block is **free prose** — write the why, the story, the anti-pattern, anything that helps a human understand the principle. Instinct stores it but doesn't try to parse it.

### Where the data comes from

Instinct already pulls signal across the whole stack — it doesn't need new permissions to enforce most principles. When you write a `**Signal:**`, Instinct maps it to one of these surfaces:

| Surface | Examples of signals |
|---|---|
| **Outlook** | Response time, after-hours sends, thread length, recipient sprawl |
| **Calendar** | Focus-block ratio, meeting density, agenda presence, on-time start rate |
| **Teams chat** | Response time, mention sprawl, after-hours messaging |
| **Tasks / To Do / Planner** | Completion rate, overdue rate, context-switch rate |
| **Goals** (Instinct's OKR system) | KR measurability, on-track %, goal↔principle linkage |
| **OneDrive / SharePoint** | Doc freshness, ownership clarity, orphan files, sharing scope |
| **Code** (GitHub) | PR cycle time, review depth, merge discipline |
| **Azure DevOps** | Sprint completion, build success rate, deploy frequency |
| **Azure Cost Management** | Spend trend, anomaly detection, unused resources |
| **Entra ID (audit logs)** | Sign-in anomalies, MFA adherence, privileged role usage |

A signal you write in plain English (e.g. *"PR cycle time < 48h"*) is mapped to a code-defined validator that knows how to measure it. When a validator can't be matched, Instinct surfaces a warning to the doc's editors so the language can be tightened — it never fails silently.

### What Instinct does with what it reads

Three feedback loops, each tightening the connection between what we say we do and what we actually do:

1. **Insight loop.** Every observation Instinct makes against a signal is stored with full evidence — which message, which meeting, which PR, when, how it scored. The dashboard's `Action Items` lane gets a new "Principles" tile showing where you're drifting from a principle this week, with the underlying evidence one click away.

2. **Guidance loop (proactive).** Instinct doesn't just retrospect. It runs forward-looking checks: a sprint kickoff in 15 minutes with no agenda doc + a principle requiring written kickoffs → Instinct DMs the sprint owner via Teams. After-hours mail send + an off-hours principle → flagged in the morning briefing the next day with a one-click "set quiet hours" action.

3. **Closure loop (auto-doc back to SharePoint).** Every Monday morning, Instinct generates a sibling document in this same folder: **`Wolfpack — Last Week vs Operating Principles.docx`**. Each principle gets a ranked observation summary, top-3 evidence rows, and a "this principle is being ignored" flag if the trend is consistently negative for three or more weeks. That report is read-only, regenerated every Monday, and itself ingested back into Instinct so we can see how policy adoption trends over time.

This last loop is the one that matters most. It means we never have to wonder if the principles are doing anything. We see, every Monday, exactly which principles drove behavior this week and which got ignored.

### When you change something

- **Editing a principle.** Save the doc. Within two hours, every Instinct surface reflects the change. The change appears as a row in the platform's `principle.updated` event log so we have an audit trail of what changed and when.
- **Removing a principle.** Delete the section. Instinct retires the principle with a `retired_at` timestamp; existing observations are preserved for historical comparison but no new ones fire.
- **Splitting a principle into two.** Add a second `## Principle:` section. Both are tracked independently going forward.
- **Pausing a principle.** Set `**Effective:** <future date>`. Instinct stops generating observations until that date passes.

### What Instinct will *not* do

- It won't auto-write principles. Only humans add them.
- It won't punish people based on principle scores. Scoreboards exist to surface patterns, not to discipline. The dashboard always exposes the underlying evidence so a low score is something we discuss, not something we act on automatically.
- It won't override what you write. If a principle is ambiguous, Instinct surfaces a warning rather than guessing. If a signal can't be mapped to data, the principle becomes "descriptive only" — visible in the dashboard but not generating observations.
- It won't ingest tools we haven't connected. Adding Azure DevOps observations, for example, requires us to wire the integration. We do that one tool at a time, only when a principle here genuinely depends on it.

### What we expect from you (the editor)

- **Write principles in language a new hire would understand.** Instinct can extract markers; it can't translate jargon.
- **Use signals sparingly and pick observable ones.** "Be respectful" is a value, not a signal. "No outbound messages 9pm–7am local" is a signal.
- **Date-stamp big changes.** When the policy bar shifts, set `**Effective:** <date>` on the new version so the scoreboard knows when to start counting differently.
- **Read the weekly auto-report.** It's the feedback this whole system is built around. If a principle is being ignored, that's the document that tells us — every Monday.
