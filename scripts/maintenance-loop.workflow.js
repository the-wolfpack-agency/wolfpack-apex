export const meta = {
  name: 'maintenance-loop',
  description: 'Drain a repo maint-queue: triage open issues, fix each in isolation, verify, open draft PRs, feed telemetry',
  whenToUse: 'Run on-demand to process the day\'s maint-queue without founder build time. Draft PRs only; founder approves the batch.',
  phases: [
    { title: 'Triage', detail: 'read open maint-queue issues, classify + prioritize' },
    { title: 'Fix', detail: 'one worktree-isolated agent per issue -> branch + verify' },
    { title: 'Report', detail: 'draft PRs opened, batch summary, telemetry emitted' },
  ],
}

// args: { repoPath, verifyCmd, label, maxIssues }  (repoPath required)
const repoPath = args?.repoPath
if (!repoPath) throw new Error('args.repoPath is required (e.g. /Users/nicholashomyk/mono/wolfpack-apex)')
const label = args?.label || 'maint-queue'
const verifyCmd = args?.verifyCmd || 'npm run verify'
const maxIssues = args?.maxIssues || 8

const ISSUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['issues'],
  properties: {
    issues: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['number', 'title', 'type', 'priority', 'area', 'plan'],
        properties: {
          number: { type: 'integer' },
          title: { type: 'string' },
          type: { type: 'string', enum: ['bug', 'feature'] },
          priority: { type: 'string', enum: ['p0', 'p1', 'p2', 'p3'] },
          area: { type: 'string', description: 'module/dir the change is scoped to; keeps parallel fixes disjoint' },
          plan: { type: 'string', description: 'one-paragraph fix approach grounded in the code' },
        },
      },
    },
  },
}

const FIX_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['issueNumber', 'status', 'branch', 'summary', 'verifyPassed'],
  properties: {
    issueNumber: { type: 'integer' },
    status: { type: 'string', enum: ['pr_opened', 'skipped', 'failed'] },
    branch: { type: 'string' },
    prUrl: { type: 'string' },
    summary: { type: 'string' },
    verifyPassed: { type: 'boolean' },
    filesTouched: { type: 'array', items: { type: 'string' } },
  },
}

phase('Triage')
const triage = await agent(
  `In the git repo at ${repoPath}, run \`gh issue list --label ${label} --state open --json number,title,body,labels --limit ${maxIssues}\`. ` +
  `For each open issue, classify it as a bug or feature, assign a priority (p0-p3), identify the single module/area the fix should be scoped to (so parallel fixes stay in disjoint files), and write a one-paragraph fix plan grounded in the actual code (read the relevant files). Return the structured list. If there are no open issues (or the label does not exist yet), return an empty array.`,
  { phase: 'Triage', schema: ISSUE_SCHEMA, effort: 'high' }
)

const queue = (triage?.issues || []).sort((a, b) => a.priority.localeCompare(b.priority)) // p0 first
if (queue.length === 0) {
  log(`maint-queue empty for ${repoPath}. Nothing to do.`)
  return { repoPath, processed: 0, results: [] }
}
log(`${queue.length} issue(s) queued. Fixing each in an isolated worktree; verify gate = \`${verifyCmd}\`.`)

phase('Fix')
// Worktree isolation per issue: fixers mutate files in parallel, so isolation avoids collisions.
const results = await parallel(queue.map((it) => () =>
  agent(
    `Repo: ${repoPath}. Read that repo's CLAUDE.md and follow it exactly (tests at every relevant layer, tie into analytics/audit, no data lost, reuse existing code, no em dashes).\n` +
    `Fix maint-queue issue #${it.number}: "${it.title}" (${it.type}, ${it.priority}, area: ${it.area}).\n` +
    `Plan: ${it.plan}\n\n` +
    `BASELINE FIRST: read the current implementation of the feature you are about to change so you have a true before/after and can tell if you broke it. ` +
    `Implement the change scoped to the "${it.area}" area only (keep files disjoint from other issues). Add/extend tests that exercise the behavior (unit + contract, and UI/E2E if there is a UI surface). ` +
    `On resolve, emit the maintenance intake telemetry (src/lib/maintenance/intake-telemetry.ts, action:'resolved') so cycle-time feeds the learning aggregator. No data lost.\n` +
    `Run \`${verifyCmd}\` (or the scoped equivalent for touched files if the full gate has a known unrelated red) and confirm it passes for your change. ` +
    `Create branch maint/${it.number}-<slug>, commit as author 25436368+nhomyk@users.noreply.github.com, push, and open a DRAFT PR that closes #${it.number}. Do NOT merge. If you cannot make verify pass, mark status 'failed' and leave the draft PR for human review. Return the structured result.`,
    { phase: 'Fix', label: `fix:#${it.number}`, schema: FIX_SCHEMA, isolation: 'worktree', effort: 'high' }
  )
))

phase('Report')
const done = results.filter(Boolean)
const opened = done.filter((r) => r.status === 'pr_opened')
const failed = done.filter((r) => r.status !== 'pr_opened')
log(`Batch: ${opened.length} draft PR(s) ready for review, ${failed.length} need attention.`)
return {
  repoPath,
  processed: done.length,
  readyForReview: opened.map((r) => ({ issue: r.issueNumber, pr: r.prUrl, summary: r.summary })),
  needsAttention: failed.map((r) => ({ issue: r.issueNumber, summary: r.summary, verifyPassed: r.verifyPassed })),
}
