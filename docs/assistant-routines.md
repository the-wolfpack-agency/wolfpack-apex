# Routines: chaining the day's tech work into one command

## The observation this is built on

There is a ceiling on how much software any one person touches in a day. A
person opens mail, reads a thread, checks a calendar, writes a doc, pings a
colleague, files a ticket, and closes the laptop. That is not a big list. It is
the same short list, in a slightly different order, five days a week.

What makes it feel big is not the number of actions. It is that every action
lives in a different tool, so the person is the integration layer: they carry
context out of one window and retype it into the next.

A routine is that carrying done for them. Not more software. The same actions
they already perform, executed the way they would perform them, chained.

## What already exists, and what does not

Nearly all of the parts are built. The missing piece is small and specific.

| Part | Status |
|---|---|
| 46 registered tools (mail, calendar, GitHub, financials, CRM, Brain, Teams) | built |
| Capability gate per tool (`tools/gate.ts`) | built |
| OGIAM authorization on every action (`ogiam/authorize`) | built |
| Hash-chained action ledger (`ogiam/ledger`) | built |
| Human approval queue with TTL (`agents/approvals/store`) | built |
| In-app notification on state change (`notifications/in-app`) | built |
| Write tools shaped as `create_*_form`, where a human confirms before anything lands | built |
| Routine runner: chains, human checkpoints, and the timing split | built (#301) |
| Capability discovery from the live registry | built (#302) |
| Human steps that use no tool, done or skipped, and what that says | built (#304) |
| Describe your day, get it mapped, keep the chain | built (#305, #306) |

The dispatcher used to return "the result of the FIRST tool whose intent
matches" and stop, which blocked every chain in this document. It no longer
does: routines are matched before single-tool dispatch, and the rest of this
file describes what that made possible.

## The design

A **routine** is an ordered list of steps with a name. A step is one of three
things, and the third is the one that matters.

1. **A tool step.** Run a registered tool with parameters, some of which may
   reference an earlier step's output.
2. **A model step.** Ask the model to produce something from what the earlier
   steps returned: a summary, a draft, a recommendation. Passes through the
   router, so it inherits redaction, residency, the budget and the content
   policy shipped in #300.
3. **A human step.** Stop. Show what has been produced. Wait.

### The human step is the product

The temptation is to build a system that does the whole chain unattended and
reports at the end. That is the wrong shape for work a person is accountable
for, and it is also the less valuable one.

A routine that pauses is doing something no dashboard does: it records the
handoff. When the chain stops at "review these three drafts" and resumes
eleven minutes later, the ledger has a fact nobody had before: the exact
boundary between what the tech did and what the person did, and how long the
person's part took.

Do that for a month and the questions change from opinion to arithmetic:

- Which step do people always edit? That tool's output is wrong; fix the tool.
- Which step do people always approve unchanged? That step does not need a
  human, and removing the pause gives them the minutes back.
- Which routine gets abandoned halfway? Something in the middle of it is
  worse than doing it by hand.

That is the audit chain between human and tech activity: not a log of what the
software did, but a measurement of where the person is still the integration
layer, ranked by how much it is costing them.

### Data flow between steps

Each step's result is put in a named slot. A later step refers to a slot rather
than re-fetching. `{{inbox}}` in step three means "what step one returned".

This is deliberately dumb, being string substitution into validated tool params,
not a scripting language. A routine anyone can read is one an operator will
trust; the moment it needs branching and loops it has stopped being a
description of somebody's morning and become a program with no test suite.

### Where the governance already lands

Nothing here needs a new permission model. Every step dispatches through the
existing pipeline, so a routine can never do something its owner could not do
one message at a time: the capability gate still runs per tool, OGIAM still
authorizes each action, the ledger still records each outcome, and every write
tool still stops for confirmation. A routine is a faster path through the same
gates, never a way around them.

---

# The catalog

Every prompt below maps to a tool that exists today. Where a step has no tool
yet, it is marked **[GAP]** with what would need building. Those are proposals,
not capabilities, and no routine should be sold on them until they are built.

## Anyone: the morning

| # | Prompt | Tool |
|---|---|---|
| 1 | "What came in overnight?" | `search_mail` |
| 2 | "What's on today?" | `calendar_widget` |
| 3 | "Prep me for my 10am." | `meeting_prep` |
| 4 | "What's waiting on me?" | `task_list_widget` |
| 5 | "What did the team say I'd do?" | `get_goals` |

**Chained, as `run my morning`:**

```
search_mail(since: yesterday)        -> inbox
calendar_widget(day: today)          -> agenda
meeting_prep(for: first(agenda))     -> brief
task_list_widget(assigned_to: me)    -> tasks
model: "Given {{inbox}}, {{agenda}}, {{tasks}}, what are the three things
        that actually matter today, and what is safe to ignore?"
HUMAN: read, adjust the three
```

The value is not the summary. It is that steps 1-4 happened before the person
sat down, and the only thing asked of them is the judgment in step 5.

## Anyone: mail to done

| # | Prompt | Tool |
|---|---|---|
| 1 | "Show me unanswered threads from this week." | `search_mail` |
| 2 | "Who is this person?" | `who_is` |
| 3 | "What did we agree with them last time?" | `search` (Brain) |
| 4 | "Draft a reply." | `create_email_form` |
| 5 | "Log the follow-up." | `create_task_form` |

**Chained, as `clear my inbox`:**

```
search_mail(unanswered: true, since: monday)  -> threads
for each thread:
  who_is(sender)                              -> person
  search(thread.subject)                      -> history
  model: draft a reply using {{person}} + {{history}}
  create_email_form(draft)                    -> HUMAN CONFIRMS EACH
create_task_form(follow_ups)                  -> HUMAN CONFIRMS
```

Every send stops for a human. The chain writes the draft; it never presses
send. That is not a limitation to be lifted later. It is the reason a person
will let it near their mailbox at all.

## Engineer: the state of everything

| # | Prompt | Tool |
|---|---|---|
| 1 | "What PRs are open?" | `search_github_pull_requests` |
| 2 | "What issues are assigned to me?" | `search_github_issues` |
| 3 | "Is CI green?" | `recent_workflow_runs` |
| 4 | "What's deployed?" | `vercel_deployments_widget` |
| 5 | "Scan the products for problems." | **[GAP]**. platform-scan exists in `src/lib/platform-scan` but is not exposed as a tool |
| 6 | "Tell the team it's ready for review." | `create_message_form` |

**Chained, as `where do things stand`:**

```
search_github_pull_requests(state: open)   -> prs
recent_workflow_runs(status: failure)      -> red
vercel_deployments_widget()                -> deploys
search_github_issues(assignee: me)         -> mine
model: "What is blocked, what is waiting on a human, and what order
        should I do it in?"
HUMAN: accept or reorder
create_message_form(to: team, body: what's ready)   -> HUMAN CONFIRMS
```

**Chained, as `email to feature`:**

```
search_mail(from: client, since: last week)  -> requests
model: extract each distinct ask
create_feature_form(each)                    -> HUMAN CONFIRMS EACH
```

This is the shape most worth building first. It is the one that today costs a
person twenty minutes of reading and retyping, and produces a record of where
the request came from, which nobody currently keeps.

## Leadership: the week

| # | Prompt | Tool |
|---|---|---|
| 1 | "How are we tracking against the OKRs?" | `get_goals` |
| 2 | "What's the revenue position?" | `get_financials_metric` |
| 3 | "What's happening across the tools?" | `cross_tool_insights_widget` |
| 4 | "What did the team ship?" | `search_github_pull_requests` |
| 5 | "Produce the update." | **[GAP]**. No document generator |
| 6 | "Put it in a deck." | **[GAP]**. No deck generator |

**Chained, as `weekly review`:**

```
get_goals()                        -> okrs
get_financials_metric(revenue)     -> money
cross_tool_insights_widget()       -> signals
search_github_pull_requests(merged, since: monday) -> shipped
model: "Where are we ahead, where are we behind, and what changed
        this week that the numbers do not explain?"
HUMAN: correct the narrative
[GAP] render to a document
```

The gap at the end is real and worth naming plainly: today this chain produces
an excellent answer in a chat window that somebody then copies into a slide.
That copy is exactly the manual carrying this whole design exists to remove.

## The gaps, ranked by how often they block a chain

1. **The chain runner itself.** Nothing above works without it.
2. **A document/report step.** Ends three of the routines here.
3. **`platform_scan` as a tool.** The engine exists; it is not reachable from
   the assistant.
4. **A deck step.** Asked for explicitly; the largest build of the four and the
   easiest to do badly.

---

# The single command

Once a routine is saved, it is one line:

```
run my morning
clear my inbox
where do things stand
weekly review
```

A routine is created the way it is used: the assistant offers to save a
sequence somebody has just performed by hand, rather than asking them to author
one in a builder. Nobody sits down to design a workflow. They do notice, on the
fourth Monday, that they have done the same six things again.

---

# Demoing this before a client has connected anything

A demo has to show the chain working end to end, and a chain that reads from
nothing has nothing to show. The instinct is to build demo tools. That is the
wrong layer, and it would leave a pile of code that gets deleted the day a real
client connects.

## Build a demo CONNECTOR, not demo tools

Every connector-backed tool already goes through one interface (`Connector` in
`src/lib/assistant/connectors/types.ts`) and one resolver
(`resolve-connector.ts`). A fixture-backed connector that implements that
interface is picked up by all of it for free:

`search_external_records`, `filter_external_records`,
`aggregate_external_records`, `get_external_record`, `get_related_records`,
`create_external_record`, `update_external_record`, `who_is`, and the CRM form
executor. Nine surfaces, no new tool code, and every routine in this document
runs against it.

The same shape already exists three times for real vendors (`hubspot`,
`salesforce`, `quickbooks` in `vendor-presets.ts`), so this is a fourth
instance of a proven pattern rather than a new mechanism.

### The dataset, for a corporate auto client

Object types matching the vocabulary those tools already speak:

| Object type | What it holds | Which prompts it lights up |
|---|---|---|
| `dealer` | Centers: region, group, contacts, performance | "how is the southwest region tracking" |
| `contact` | Customers and dealer staff | `who_is`, "who owns this account" |
| `deal` | Enquiry through delivery, with stage and value | "what's in the pipeline this month" |
| `vehicle` | Stock: VIN, model, status, location | "what do we have in stock" |
| `ticket` | Service and support cases, with SLA state | "what's escalated and breaching" |
| `activity` | Calls, visits, test drives | "what happened with this customer" |

That set is chosen so the **cross-object** questions work, because those are
the ones no single vendor tool answers today and the ones that make the chain
look inevitable: "which dealers have deals stalled at finance for more than a
week, and do they have the stock to close them?"

### Rules for the fixture data

- **Invented entities only.** No real dealer, group, or person. A demo dataset
  that mixes in real names is one screenshot away from being a client's data in
  someone else's pitch.
- **Isolated to a demo workspace.** The connector reports `isConfigured()` false
  everywhere else, so demo records can never appear beside a client's real ones.
- **Visibly demo.** Labeled in the UI, not merely known to be fake by the
  person presenting.
- **Internally consistent.** Dates, stages and totals that survive arithmetic,
  because the first thing a sharp prospect does is add up a column.

## Ticketing and the rest

Ticketing needs no new tool either. It needs a preset. Zendesk, Jira and
ServiceNow are REST APIs with the same auth-header-and-paths shape the existing
three presets describe, so each is a table entry rather than a feature.

The DMS is further along than the rest: `dms_inventory_widget` already drives a
real dealer site through a headless browser, which means live inventory in a
demo without integrating CDK or Tekion first.

## The auto routine this unlocks

```
search_external_records(ticket, sla_breaching)      -> at_risk
get_related_records(each -> contact, vehicle)       -> context
search_external_records(vehicle, in_stock, match)   -> options
model: "Which of these can be resolved today, and with what?"
HUMAN: pick
create_message_form(to: dealer, body: the plan)     -> HUMAN CONFIRMS
create_task_form(the rest)                          -> HUMAN CONFIRMS
```

Six tools, two confirmations, one command, and every step is a thing somebody
at that client already does by hand, in a different window each time.
