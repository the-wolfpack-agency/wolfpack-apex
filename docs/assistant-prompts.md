# What to type

Every prompt here maps to something registered in the product today: 50 tools,
3 built-in chains, and whatever you have saved yourself. Nothing below is
aspirational. Where a capability does not exist, this file says so rather than
suggesting a phrasing that will not work.

Design and reasoning live in `assistant-routines.md`. This is the usage side.

## Start here

| Type this | What happens |
|---|---|
| `what can you do` | Reads the live registry and lists what YOUR role can run, chains first. Never a written page, so it cannot go stale. |
| `here's what I do on a Monday: ...` | Maps your description onto real tools, marks the parts that are yours, names what has nothing behind it, and offers to chain the rest. |
| `yes` | Keeps the chain it just offered. `no` discards it. |

The middle one is the fastest way to see what the product can do for your job
specifically, because it answers in your words rather than ours.

## The chains that ship

| Command | What it runs |
|---|---|
| `run my morning` | Calendar, open tasks, brief for your next meeting, then one pass over all three. Stops for you to accept or change the priorities. |
| `where do things stand` | Open PRs, open issues, what is blocked and in what order. Stops for you, then opens a message to the team. |
| `weekly review` | Goals, revenue position, cross-tool signals, then a draft review. Stops for you to correct the narrative. |

Anything you saved runs the same way, under whatever you called it.

## One thing at a time

These are the individual tools. A chain is several of them in order; typing one
on its own is always available and always cheaper.

**Mail and people**

```
did Dana email me about the renewal
find my emails from Priya about the invoice
who is Marguerite Halloran
show me my recent emails
draft a follow-up email
```

**Calendar and meetings**

```
what's on my calendar
show me my calendar
prep for my next meeting
brief me for my next meeting
when is everyone free on Thursday
```

**Work in flight**

```
show me my tasks
what are our okrs
log time 1.5h on WOLFPACK-AUTO
what should I know
```

**Code and deployments**

```
what PRs are open
open PRs in wolfpack-auto
show me failed CI runs in wolfpack-apex
is the build green for wolfpack-apex
what's deployed
open scan findings
what did the scan find for beyond
```

**Customers and records**

```
look up Acme Industrial
find dana@example.com
deals over $50k closing this month
Acme's open opportunities
how many deals are in negotiation
```

**Money and documents**

```
what was revenue this quarter
scan invoice
scan receipt
```

**Knowledge**

```
search the brain for the onboarding policy
what do we know about the pricing change
remember that Dana's renewal date is 14 March
```

## Chaining them yourself

The fastest route is to describe the sequence rather than assemble it. Say what
you actually do, in order, in one message:

```
Here's what I do on a Monday: I read the overnight email, check my calendar, prep for the client call, rehearse the opening out loud, then send the team a status note.
```

You get back each step marked as one of three things, and an offer:

- **something it can already do**, naming the tool
- **yours**, for work no software should be doing
- **nothing here does this yet**, stated plainly rather than dropped

Say `yes` and it becomes a command. The chain stops at every step that is
yours, and every write still asks before it happens.

### What a good description looks like

- **In order.** The order you say it in is the order it runs.
- **One action per clause.** "Read the email, check the calendar" beats "get
  set up for the day".
- **Include the human parts.** Rehearsing, calling someone, walking the floor.
  Leaving them out produces a chain that skips the parts that matter most, and
  the product cannot then tell you what they cost you.
- **Longer than a sentence.** A short message is treated as a question, not a
  description, so it does not spend a model call.

## How this adapts

### When you ask for something that does not exist

It says so. Every described step with nothing behind it is counted, per run,
across everybody. That count is the build queue: real work, from real people,
ranked by how often it comes up, rather than a list assembled in a planning
meeting. Asking for something we do not have is therefore useful rather than a
dead end.

If a tool exists but your role cannot run it, it says that instead. It is never
proposed and then withdrawn.

### When a new tool is built

It appears in `what can you do` and becomes available to `plan_my_day`
immediately, with no documentation to update and no list to maintain. Both read
the live registry, so the product describes itself as it is rather than as it
was when somebody last wrote it down. That is the whole reason neither is a
written page.

### When your work changes

Save a chain under the same command again and it replaces the old one. Nothing
to edit, no builder to learn: describe the new version of the day and say yes.

If a chain refers to a tool that has since been removed, it stops at that step
and says which one needs editing rather than failing silently or skipping ahead.

### When a step turns out to be wrong

The product measures its own suggestions. For every step you are asked to do
yourself it records whether you did it and how long it took, and after enough
runs it tells you one of four things about that STEP, never about you:

- it is not happening, and here are both reasons that might be
- it is habitual and expensive, so ask which part of it is mechanical
- it is a pause nobody spends time on, so consider removing it
- it is working, nothing to change

A step you skip is recorded without penalty. That is deliberate: a routine that
punishes a skip teaches people to tick the box, and a tick that means nothing
destroys the only measurement worth having.

## What it will not do

Worth knowing up front, because these are choices rather than gaps:

- **Nothing is sent, filed or told to anybody without you confirming it.** A
  chain drafts the email; you send it.
- **A chain never runs on a schedule.** It runs when you type its name. Timing
  ("the day before, prep the brief") is not built yet.
- **A scan is never started from chat.** Findings are readable; running a scan
  sends real traffic at a real system and stays a deliberate act.
- **A chain is never built with a hole in it.** Steps with no tool behind them
  are left out and reported, rather than producing a chain that stops halfway.
