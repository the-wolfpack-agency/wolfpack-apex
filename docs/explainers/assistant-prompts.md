# Wolfpack Assistant prompts, explained

> A living catalogue of every prompt the Assistant knows how to handle deterministically (no AI tokens spent). Onboarding doc for new employees, snippet source for the chat UI's "Try asking…" suggestions, and the canonical reference for the demo team.

```yaml
sources:
  - src/lib/assistant/tools/                          # every tool's matchIntent() regex set
  - src/lib/assistant/tools/__tests__/                # each prompt below is in a green test
  - src/lib/assistant/intent-router.ts                # legacy intent classifier (calendar/mail/financials/goals)
last_translated: 2026-05-16
```

---

## How to read this doc

Every prompt below is **verified** — it has a matching test that asserts the Assistant dispatches the right tool with the right parameters. If a prompt is in this doc, it works in production. If a phrasing isn't here, the Assistant may still answer it via the AI fallback path, but it'll spend tokens and the answer won't be as fast or as deterministic.

Two ways to use the catalogue:

1. **For employees / clients** — copy a prompt verbatim, swap the placeholders (`<repo>`, `<vendor>`, `<contact name>`), and try it. Every prompt has a sample answer you can compare against to know it worked.
2. **For the UI** — these are the snippets we seed into the chat's "Try asking…" hints. When we add a new prompt pattern, it goes here first; the UI consumes the doc.

The Assistant runs the tools in registration order. When two tools could plausibly match, the **more-specific** one wins. That's why "find the deal for Acme" (free-text search) doesn't get swallowed by the loose "look up by ID" tool.

---

## CRM — Salesforce, HubSpot

Every CRM answer ends with a styled vendor badge next to "Zero tokens" (Salesforce cyan, HubSpot orange, etc.) so multi-CRM workspaces can tell at a glance which system answered.

### 1. Look up a contact / account by name

| Prompt | What the Assistant does |
| --- | --- |
| `look up Grimace Fromcdonalds` | Searches all contacts in the workspace's connected CRM. |
| `find Grimace in salesforce` | Same — the trailing "in salesforce" / "in our CRM" is stripped before search. |
| `search for McDonald's` | Free-text. Apostrophe is SOQL-escaped automatically. |
| `find grimace@mcdonalds.com` | Email search. Always routes to Contact. |
| `find the contact for Grimace` | Typed-object search. |
| `find the account for Acme` | Typed-object search, routed to Account. |
| `who is Grimace Fromcdonalds` | Identity question → contact search. |
| `look up Acme in our CRM` | Free-text. "in our CRM" stripped. |

### 2. Look up a record by ID

When you already have a Salesforce ID, skip the search step:

| Prompt | Notes |
| --- | --- |
| `look up contact id 003g500000GemUXAAZ` | 18-char SF ID. |
| `look up account id 001…` | Account ID. |
| `find the deal with id 006…` | Same path. |

### 3. Filter queries (deals over $50k, closing this month, …)

Combines amount / date / stage / owner clauses in one query. Each clause is independent — mix and match.

| Prompt | Filter |
| --- | --- |
| `deals over $50k` | Amount > $50,000 |
| `opportunities above 100000` | Amount > $100,000 |
| `deals under $10k` | Amount < $10,000 |
| `deals $1m or more` | Amount >= $1,000,000 |
| `deals closing this month` | CloseDate in current month |
| `opportunities closed last month` | CloseDate in prior month |
| `deals this quarter` | CloseDate in current quarter |
| `deals stuck in Proposal` | Stage = Proposal |
| `opportunities in Closed Won` | Stage = Closed Won |
| `deals over $50k closing this month` | Amount + date |
| `deals over $50k in Proposal` | Amount + stage |
| `deals owned by Jorge` | Owner = Jorge (resolved against User table) |

### 4. Aggregate queries — count / sum / average / win rate / top-N

Counts, totals, averages, conversion metrics. Every filter clause above also works inside an aggregate.

#### Count
- `how many deals`
- `count of contacts`
- `how many deals over $50k closing this month`
- `number of opportunities in Closed Won`

#### Sum / total
- `total pipeline value`
- `pipeline value this quarter`
- `total amount of deals over $50k`

#### Average
- `average deal size`
- `average amount of opportunities this quarter`

#### Win rate
- `what's my win rate`
- `win rate this quarter`
- `conversion rate last month`

#### Top-N
- `top 3 deals`
- `top 5 accounts by revenue`
- `top 10 deals by amount`

### 5. Related-record queries ("Acme's opportunities")

Walks the parent → child relationship instead of asking the user to know IDs.

| Prompt | What it returns |
| --- | --- |
| `Acme's opportunities` | All open deals for the Account named "Acme" |
| `Acme Industries's open deals` | Same — possessive variants supported |
| `show me Acme's contacts` | Contacts linked to Acme |
| `show me opportunities for Acme` | Same — "for X" works too |
| `Jorge's deals` | Deals where Owner.Name resolves to "Jorge" |
| `what deals does Jorge own` | Same |

### 6. Action tools — create / update (Phase-3 confirmation gate)

These mutate state, so the first turn asks "are you sure?". The user's next turn (`yes` / `confirm` / `do it`) executes; anything else cancels.

| Prompt | Outcome |
| --- | --- |
| `add a new contact: Jorge Colon at Acme` | Drafts a Contact create with FirstName/LastName/Account, waits for confirmation. |
| `add a contact named Sarah Lee, email sarah@acme.com` | Same with email captured. |
| `log a call with Jorge about pricing` | Drafts a Task create (Type = Call). |
| `create a task to follow up Friday` | Drafts a Task with DueDate. |
| `set Jorge's email to jorge@new.com` | Update on the Contact found by name. |
| `move deal Q3 to stage Proposal` | Update Opportunity.StageName. |
| `move the Acme Renewal to Closed Won` | Same. |

> Action tools require an active SF / HubSpot connection. If the workspace has neither, you'll get a "connect a CRM first" message, not a hallucinated success.

---

## GitHub — PRs, issues, workflow runs

All three tools share the same `the-wolfpack-agency` org PAT. Repo is matched as a bare repo name (`wolfpack-apex`) or as `owner/repo`. Author is `@nhomyk` or `nhomyk`.

### Pull requests

| Prompt | Filter |
| --- | --- |
| `what PRs are open` | Org-wide, state = open |
| `open pull requests` | Same |
| `show me PRs` | Defaults to open |
| `PRs in wolfpack-apex` | Repo-scoped |
| `open PRs in wolfpack-auto by nhomyk` | Repo + state + author |
| `PRs by @nhomyk` | Author only |
| `closed PRs` | State = closed |
| `closed pull requests in the-wolfpack-agency/wolfpack-apex` | Full org/repo form |

### Issues

| Prompt | Filter |
| --- | --- |
| `open issues in wolfpack-apex` | Repo + state |
| `closed issues in wolfpack-auto` | Repo + state |
| `any GitHub issues` | Org-wide, state = open |
| `issues labeled urgent in wolfpack-apex` | Label filter |
| `open bugs in wolfpack-auto` | "bugs" → label = bug |
| `closed github issues by @alice` | Author + state |

### Workflow runs (GitHub Actions)

Repo is **required** — we don't fan out across the org.

| Prompt | Filter |
| --- | --- |
| `recent workflow runs in wolfpack-apex` | All statuses |
| `show me failed CI runs in wolfpack-auto` | Status = failure |
| `is the build green for wolfpack-apex` | Status = success |
| `what is running in wolfpack-apex actions` | Status = in_progress |
| `cancelled workflow runs in wolfpack-apex` | Status = cancelled |

---

## Calendar

Pulls from Microsoft 365 calendar (Graph API) plus internal transcripts and Teams meeting metadata.

### Free / busy
- `am I free Thursday`
- `is Nick free tomorrow`
- `am I free at 2pm Friday`
- `is Hoxsie busy this afternoon?`
- `what's on Hoxsie's calendar tomorrow`

### What's on my calendar (verbose phrasing)

The Assistant understands a wide range of phrasings for "show me what's on my calendar for X". Day-of-week names ("monday", "next wednesday", "this thursday") resolve to the right date — they don't fall back to today.

| Prompt | Resolves to |
| --- | --- |
| `what is on my calendar monday?` | upcoming Monday |
| `what's on my calendar tuesday` | upcoming Tuesday |
| `what is on my calendar next wednesday` | next week's Wednesday |
| `what's on my schedule friday?` | upcoming Friday |
| `what's on my agenda this thursday` | this week's Thursday (may be past) |
| `what's on my calendar today` | today |
| `what's on my calendar tomorrow` | tomorrow |

### Meetings on a specific day
- `what meetings do I have on Monday`
- `any meetings tomorrow?`
- `my meetings next week`
- `my schedule Friday`
- `my calendar saturday`
- `Calendar Monday` *(bare day-of-week)*
- `Agenda next week`

### Topic search
- `any meetings about the porsche pitch`
- `any meetings about Q3 launch`

---

## Interactive widgets — act inside the chat

Some prompts return an **inline widget** — a small interactive surface (a calendar grid, an email thread, a task list) rendered below the answer text. The user can click into the widget without leaving the chat: expand a day, click out to a detail page, or jump to the underlying tool.

### Calendar widget
- `calendar`
- `show me my calendar`
- `show my calendar`
- `open calendar`
- `calendar widget`
- `show calendar`

Renders a mini month grid for the current month with dots on days that have meetings. Click any day to expand its meeting list, then click into Instinct (in-app detail page) or Outlook (web link) for each event. A header "Open full calendar" link jumps to `/calendar`.

Bare day-of-week prompts (`Calendar Monday`, `my schedule Friday`) still go to the text-based meetings-on-a-day lookup above — the widget is reserved for the "show me the whole month" intent.

### Email thread widget
- `inbox`
- `show me my inbox`
- `recent emails`
- `show my email`
- `email widget`

Renders the user's 10 most recent emails as a scannable list. Unread messages render in bold. Each row links to Outlook on the web. A header "Open full inbox" link jumps to `/emails`.

Specific-search phrasings (`find emails about Q3`, `any emails from hoxsie`) still go to the text-based mail-search tool — the widget is reserved for the "just show me my inbox" intent.

### Task list widget
- `tasks`
- `my tasks`
- `open tasks`
- `task list`
- `to-do list` / `todos` / `todo`
- `show tasks`

Renders the user's open MS To-Do tasks with check-off buttons inline. Click the circle to complete a task (writes through to Graph + the local cache). Click the title to open the task on the `/tasks` page. Overdue tasks render in red.

---

## Action forms — structured create flows

For destructive or external actions (sending email, creating tasks, booking meetings, posting to a Teams chat) the Assistant returns an **inline form** in the chat instead of free-text. The Send/Create button stays disabled until every required field is filled — no accidental sends.

### Create email
- `create email`
- `compose an email`
- `draft an email`
- `send an email`
- `create email to alice@example.com about Q3 plan` *(pre-fills To + Subject)*

Required fields: To, Subject, Message. Optional: Cc.

### Create message (Teams chat)
- `create message`
- `send a teams message`
- `draft a teams message`
- `new message`

Required: Teams chat id, message body. (Chat-name autocomplete is on the roadmap; for now, paste the id from the URL of `/messages`.)

### Create calendar event
- `create calendar event`
- `create event`
- `schedule a meeting`
- `book a meeting`
- `set up a call`
- `schedule a meeting titled Q3 review` *(pre-fills title)*

Required: Title, Start, End. Optional: Attendees, Notes.

### Create task
- `create task`
- `add a task`
- `new task`
- `create a todo`
- `create task titled Ship Q3` *(pre-fills title)*

Required: Title. Optional: Details, Due date, Priority.

> Note: `create a task to follow up Friday` is intentionally routed to the CRM action tool (Salesforce / HubSpot) instead of MS To-Do. The verb-form "to follow up" signals a CRM activity. Use bare `create task` for an MS To-Do task.

### Create OKR (CEO / CTO / EVP only)
- `create OKR`
- `new OKR`
- `add OKR`
- `create objective`
- `draft OKR titled Ship Q3 launch` *(pre-fills the objective)*

Required: Quarter (defaults to current), Objective, one Key Result (metric + numeric target). Other roles get a 403 on submit.

### Create feature request
- `create feature`
- `new feature request`
- `request a feature`
- `file a feature`
- `add a roadmap item`

Required: Title, Description. Optional: Target product, Priority, Category.

### Create CRM record (deal / contact / account / task)
The form is vendor-aware. Fields adapt per object type so the write succeeds first try (no more "StageName required" 400s).

- `create deal`
- `create a $10k deal with Acme Industries` *(pre-fills name + amount)*
- `add new opportunity`
- `create contact jane@example.com` *(pre-fills email)*
- `create account named Acme Industries`
- `create CRM task` *(distinguished from MS To-Do `create task`)*

Required per type:
- **Deal**: Name, Amount, Stage (defaults Prospecting), Close date (defaults today)
- **Contact**: Last name
- **Account**: Name
- **CRM task**: Subject

---

## Mail — inbox search

- `find emails from Max`
- `find the email from James about the Q2 retainer`
- `emails from Sarah about pricing`
- `recent emails from Acme`

---

## Goals / OKRs

- `what are our OKRs`
- `what are our current OKRs?`
- `show me our north star`
- `who owns the goal "ship Q3 launch"`

---

## Financials (CTO / CEO only)

- `what's our revenue this quarter?`
- `what's our MRR this quarter?`
- `how much cash do we have?`
- `revenue is up` *(narrative reflection — triggers a metric pull + commentary)*
- `the budget feels tight`

Phrasings like "revenue is up" deliberately route through the tool so the answer is grounded in the actual number, not the user's vibe.

---

## Org facts — institutional memory

Reads from the org-wide correction store populated by the learning loop. Every correction the team makes ("the decision was Tuesday, not Wednesday") is queryable here.

- `what do we know about Acme`
- `tell me about the Porsche pitch`
- `what are the facts on Q3 launch`
- `what's known about the program team`

---

## Page-facts (when you're already on a page)

The Assistant knows which page you're looking at. Questions about that page's data route to a page-facts answer with a one-click "Go to X" link.

- `where do I go to update billing`
- `what does this page do`
- `take me to settings`

---

## What's NOT in this doc

- **Pure AI fallback** — open-ended questions that don't match any tool fall through to a bounded LLM call ("what did we talk about with the program lead last week"). Tokens spent. No deterministic answer to document.
- **Internal / admin tools** — `/admin/connectors`, capability-gated routes, etc. Those have their own onboarding under `docs/features/`.
- **Future integrations** — Jira, Notion, Stripe, Zendesk. When they ship, prompts get added here in the same shape.

---

## Quick-start: 6 prompts a new employee should try in their first 10 minutes

1. `what are our OKRs` — confirms goals lookup works for them.
2. `am I free Thursday at 2pm` — confirms their MS 365 calendar is linked.
3. `top 3 deals` — confirms CRM connector works (assuming SF/HubSpot is connected).
4. `what PRs are open in wolfpack-apex` — confirms GitHub PAT is provisioned (devs only).
5. `what do we know about <a teammate's name>` — pulls org facts about that person.
6. `find emails from <a teammate>` — confirms inbox search is wired.

If any of these six return an error, the answer is in the message body — usually "connect X from /admin/integrations first."
