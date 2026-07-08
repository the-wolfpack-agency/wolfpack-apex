# Maintenance loop runbook (Instinct / wolfpack-apex)

The maintenance rails turn the agency's daily bug/feature requests into a queue that
agents drain, so the founder reviews batches instead of building every request by hand.
This is the reliability floor that lets apex run without the founder's build time.

## The pieces

1. **Intake** — file issues with the `Maintenance: bug` / `Maintenance: feature`
   templates (`.github/ISSUE_TEMPLATE/`). They apply the `maint-queue` label.
2. **Telemetry / learning** — `src/lib/maintenance/intake-telemetry.ts` mirrors every
   issue lifecycle event (opened / triaged / resolved + cycle-time) into the existing
   analytics (`maintenance.intake.*`) + hash-chained audit log, and feeds the learning
   aggregator. No data lost; it never throws (degrades to analytics-only on audit failure).
3. **Loop** — `scripts/maintenance-loop.workflow.js`, run on-demand.

## Run it (on-demand)

From a Claude Code session, invoke the Workflow tool with this script and args:

```
Workflow({
  scriptPath: "scripts/maintenance-loop.workflow.js",
  args: { repoPath: "/Users/nicholashomyk/mono/wolfpack-apex", verifyCmd: "npm run verify" }
})
```

Or just tell the session: **"drain the apex maint-queue"**.

## What it does, and the safety model

- Triages every open `maint-queue` issue (type, priority, scoped area, fix plan).
- Fixes each issue in its **own git worktree** (parallel fixers can't collide), scoped
  to one area so diffs stay disjoint.
- Runs the **verify gate** per fix. NOTE: apex's full `npm run verify` has a known
  pre-existing red in the eslint flat-config; fixers fall back to the scoped
  tsc + jest for touched files and report the pre-existing red honestly.
- Opens a **draft PR per issue** (branch `maint/<n>-<slug>`, closes the issue). It
  **never merges** — the founder approves the batch. Auto-merge stays reserved for
  green dependency bumps only.
- Emits resolved-telemetry so fix latency becomes learnable signal.

## Arming

Currently **on-demand** (founder triggers). Once a few clean batches have been
reviewed, this can be promoted to a daily schedule (a routine that drains the queue
each morning). Do not schedule it against this client-facing repo until the loop has a
track record.
