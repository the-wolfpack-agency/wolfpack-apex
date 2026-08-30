/**
 * Ask several models to do real work from this repo's history, and let the gate
 * decide who did it.
 *
 * WHAT MAKES THIS DIFFERENT FROM A BENCHMARK
 *
 * The tasks are changes that were actually made here, and each one is graded by
 * the test that actually shipped with it. So the question is not "does this
 * model score well on somebody else's problems", it is "can this model do OUR
 * work and survive OUR gate", which is the only version that changes a routing
 * decision.
 *
 * THE MODEL RETURNS A FILE, NOT A DIFF, AND THAT IS DELIBERATE
 *
 * Models produce invalid unified diffs often enough that scoring them on diff
 * syntax would measure formatting rather than engineering. So a model returns
 * the full contents of the file it is changing, the runner writes it into an
 * isolated tree, and `git diff` produces the patch. The gaming check then reads
 * a diff that git generated rather than one a model wrote, which is both more
 * reliable and harder to fool.
 *
 * SAFETY, WHICH IS NOT OPTIONAL HERE
 *
 * This writes model-generated code to disk and runs it. Every attempt happens
 * in a throwaway git worktree that is removed afterwards. The working tree is
 * never touched, nothing is ever committed, and nothing is ever pushed. If the
 * worktree cannot be created the attempt is abandoned rather than falling back
 * to running in place.
 *
 * COST
 *
 * N models times M tasks real calls, each writing a whole file, so this is not
 * cheap and is never automatic. It runs because somebody asked. Every leg goes
 * through the same router as production, so the budget governor still applies
 * and a refused leg is reported rather than hidden.
 *
 * Usage:
 *   npx tsx scripts/screen-models-on-code.ts                 # all tasks, all tiers
 *   npx tsx scripts/screen-models-on-code.ts --task downgrade
 *   npx tsx scripts/screen-models-on-code.ts --tiers small,large
 */
import { execFileSync, execSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve, sep } from "node:path";
import {
  scoreScreen,
  detectOracleGaming,
  type CodeTask,
  type ScreenAttempt,
  type AttemptOutcome,
} from "../src/lib/ai/code-screen";
import { TASKS } from "../src/lib/ai/code-screen-tasks";
import type { AIModelTier, AICompleteRequest, AICompleteResponse } from "../src/lib/ai/types";

const REPO = process.cwd();

/** Run a command, returning its output and whether it succeeded. */
function run(cmd: string, args: string[], cwd: string, timeoutMs = 600_000) {
  try {
    const out = execFileSync(cmd, args, {
      cwd,
      encoding: "utf8",
      timeout: timeoutMs,
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    });
    return { ok: true, out };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, out: `${e.stdout ?? ""}\n${e.stderr ?? ""}${e.message ?? ""}`.trim() };
  }
}

/**
 * The scoped gate: typecheck plus the tests that grade this task.
 *
 * NOT the full 9-stage gate, and the reason is arithmetic rather than laziness:
 * at ten minutes a stage, N models times M tasks would take days and nobody
 * would ever run it. Typecheck is repo-wide because a change that breaks an
 * unrelated file has not done the job, and the graded tests are the task's own
 * definition of done.
 *
 * A model that passes this has NOT passed the full gate, and the report says
 * so. Overstating what a green scoped run means is the exact failure this
 * codebase keeps finding: a check that is narrower than its name.
 */
function runScopedGate(worktree: string, task: CodeTask): { ok: boolean; error: string } {
  const tsc = run("npx", ["tsc", "--noEmit"], worktree);
  if (!tsc.ok) {
    const first = tsc.out.split("\n").find((l) => l.includes("error TS")) ?? "typecheck failed";
    return { ok: false, error: first.slice(0, 200) };
  }
  const jest = run("npx", ["jest", "--runTestsByPath", ...task.gradedBy], worktree);
  if (!jest.ok) {
    const first =
      jest.out.split("\n").find((l) => /✕|●|failed/i.test(l))?.trim() ?? "graded tests failed";
    return { ok: false, error: first.slice(0, 200) };
  }
  return { ok: true, error: "" };
}

/** Pull the file body out of a reply, tolerating a fenced block or a bare one. */
function extractFileBody(reply: string): string | null {
  const fenced = /```(?:[a-zA-Z]*)\n([\s\S]*?)```/.exec(reply);
  const body = (fenced?.[1] ?? reply).trim();
  /* A refusal or an apology is not a file. Requiring something that looks like
     code keeps "I can't help with that" out of the failed bucket, where it
     would read as a model that tried and got it wrong. */
  if (body.length < 40) return null;
  if (!/[;{}]|=>|function |export |import /.test(body)) return null;
  return body;
}

async function attemptTask(
  task: CodeTask,
  tier: AIModelTier,
  /* The real router signature, injected. Nothing here knows how to spend money;
     the chokepoint stays the only thing that does. */
  complete: (req: AICompleteRequest) => Promise<AICompleteResponse>,
): Promise<ScreenAttempt> {
  /* THE TREE IS BUILT BEFORE THE MODEL IS ASKED ANYTHING, because the prompt
     has to contain the file as it was at baseCommit. Reading it from HEAD would
     hand over the finished fix and measure transcription. */
  const dir = mkdtempSync(join(tmpdir(), "code-screen-"));
  const worktree = join(dir, "wt");
  const cleanup = () => {
    try {
      execSync(`git worktree remove --force "${worktree}"`, { cwd: REPO, stdio: "ignore" });
    } catch {
      /* Best effort. A leftover worktree is untidy, not dangerous. */
    }
    rmSync(dir, { recursive: true, force: true });
  };

  let original: string;
  try {
    /* A SHALLOW CLONE CANNOT RUN THIS, AND SHOULD SAY SO.
     *
     * The whole design rests on checking out the commit BEFORE the change, so
     * a checkout without that history cannot screen anything. Left to git this
     * surfaces as an opaque "invalid reference" halfway through a paid run. */
    try {
      execSync(`git cat-file -e ${task.baseCommit}^{commit}`, { cwd: REPO, stdio: "ignore" });
    } catch {
      throw new Error(
        `base commit ${task.baseCommit} is not in this checkout. ` +
          `The screen needs history before the change; run: git fetch --unshallow`,
      );
    }

    execSync(`git worktree add --detach -q "${worktree}" ${task.baseCommit}`, {
      cwd: REPO,
      stdio: "ignore",
    });

    /* The exam paper, brought to the candidate. The graded test did not exist
       at baseCommit, so it is copied in from HEAD and committed, which makes it
       part of the tree the model is working against and therefore visible to
       the gaming check if anything ever removes it. */
    for (const g of task.gradedBy) {
      mkdirSync(dirname(join(worktree, g)), { recursive: true });
      writeFileSync(join(worktree, g), readFileSync(join(REPO, g), "utf8"), "utf8");
    }
    execSync(`git add -A && git -c user.email=screen@local -c user.name=screen commit -q -m overlay`, {
      cwd: worktree,
      stdio: "ignore",
    });

    /* Absent at baseCommit means this is a create-the-file task, which is a
       real shape of work and not an error. */
    original = existsSync(join(worktree, task.targetFile))
      ? readFileSync(join(worktree, task.targetFile), "utf8")
      : "";
  } catch (err) {
    cleanup();
    return {
      taskId: task.id,
      model: `tier:${tier}`,
      outcome: "errored",
      costUsd: 0,
      latencyMs: 0,
      gateError: `could not prepare worktree: ${(err as Error).message.slice(0, 120)}`,
    };
  }

  let reply: { content: string; model_used: string; cost_usd: number; latency_ms: number };
  try {
    reply = await complete({
      messages: [
        {
          role: "user",
          content:
            `${task.prompt}\n\n` +
            (original
              ? `The file is \`${task.targetFile}\`. Its current contents:\n\n` +
                "```typescript\n" + original + "\n```\n\n"
              : `Create the file \`${task.targetFile}\`. It does not exist yet.\n\n`) +
            `Return the COMPLETE new contents of that file and nothing else. ` +
            `Do not change any test file.`,
        },
      ],
      system:
        "You are editing a production TypeScript codebase. Return only the full new file contents in a single fenced code block. No explanation.",
      max_tokens: 8000,
      model_tier: tier,
      /* The task rides in `feature` rather than a new metadata field, so each
         task's spend shows up in the cost dashboard that already exists
         (v_ai_cost_daily) instead of needing a second place to look. */
      metadata: { feature: `code-screen.${task.id}`, routing_reason: "code_screen" },
    });
  } catch (err) {
    /* A budget refusal or provider error is not the model failing the task.
       Collapsing the two would blame a model for a ceiling somebody else set. */
    cleanup();
    return {
      taskId: task.id,
      model: `tier:${tier}`,
      outcome: "errored",
      costUsd: 0,
      latencyMs: 0,
      gateError: (err as Error).message.slice(0, 160),
    };
  }

  const base: Omit<ScreenAttempt, "outcome"> = {
    taskId: task.id,
    model: reply.model_used,
    costUsd: reply.cost_usd,
    latencyMs: reply.latency_ms,
  };

  const body = extractFileBody(reply.content);
  if (!body) {
    cleanup();
    return { ...base, outcome: "no_patch" };
  }

  let outcome: AttemptOutcome = "failed";
  let gateError = "";
  let gaming;

  try {
    /* THE MODEL'S OUTPUT LANDS INSIDE THE WORKTREE OR NOWHERE.
     *
     * `body` is text a model wrote and `targetFile` decides where it goes, so
     * a path that climbs out of the worktree would let a screening run write
     * into the real repository. Nothing today supplies "../", and this runner
     * is a step away from letting a model choose its own target, which is
     * precisely when a check nobody added becomes expensive.
     * resolve() collapses any traversal before it is compared, so "a/../../x"
     * is judged by where it lands rather than how it is spelled. */
    const target = resolve(worktree, task.targetFile);
    const root = resolve(worktree);
    if (target !== root && !target.startsWith(root + sep)) {
      throw new Error(`refusing to write outside the worktree: ${task.targetFile}`);
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, body, "utf8");

    /* git writes the diff, not the model, and it covers the WHOLE tree rather
       than just the target. This runner only lets a model write one file, so
       today the guard can only fire on that file. Diffing everything means the
       guard stays correct when the agent loop gains unrestricted writes, which
       is exactly where deleting the failing test becomes the locally optimal
       move. */
    const patch = run("git", ["diff", "HEAD"], worktree).out;

    gaming = detectOracleGaming(patch, task);
    if (gaming.gamed) {
      outcome = "disqualified";
    } else if (patch.trim() === "") {
      /* Returned the file unchanged. Not a failure to compile, a failure to
         attempt, and worth telling apart. */
      outcome = "no_patch";
    } else {
      /* node_modules is not in the worktree; link the real one rather than
         reinstalling per attempt. */
      /* NO SHELL. This built a command string with ${REPO} interpolated into
         it and handed it to a shell, which CodeQL flagged as
         js/shell-command-injection-from-environment. REPO comes from the
         environment, so a path containing a quote or a semicolon executed
         whatever followed it.
         symlinkSync does the same job with no shell to inject into, which is
         the fix rather than a better-quoted string: escaping is a thing you
         can get wrong, and not invoking a shell is not. */
      symlinkSync(join(REPO, "node_modules"), join(worktree, "node_modules"));
      const gate = runScopedGate(worktree, task);
      outcome = gate.ok ? "passed" : "failed";
      gateError = gate.error;
    }
  } catch (err) {
    outcome = "errored";
    gateError = (err as Error).message.slice(0, 160);
  } finally {
    cleanup();
  }

  return {
    ...base,
    outcome,
    ...(gaming?.gamed ? { gaming } : {}),
    ...(gateError ? { gateError } : {}),
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const arg = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  const only = arg("task");
  const tasks = only ? TASKS.filter((t) => t.id === only) : TASKS;
  const tiers = (arg("tiers")?.split(",") ?? ["small", "large"]) as AIModelTier[];

  if (tasks.length === 0) {
    console.error(`No task "${only}". Known: ${TASKS.map((t) => t.id).join(", ")}`);
    process.exit(2);
  }

  /* Imported lazily so --help and a bad task name do not require credentials. */
  const { getAIClient } = await import("../src/lib/ai/router");
  const client = getAIClient();
  const complete = (req: Parameters<typeof client.complete>[0]) => client.complete(req);

  console.log(
    `Screening ${tiers.length} tiers against ${tasks.length} real task(s) from this repo.\n` +
      `Each attempt runs in a throwaway worktree. Nothing is committed or pushed.\n`,
  );

  const attempts: ScreenAttempt[] = [];
  /* Sequential for the same reason runComparison is: parallel legs would each
     be judged against a spend figure taken before the others were billed. */
  for (const task of tasks) {
    for (const tier of tiers) {
      process.stdout.write(`  ${task.id} @ ${tier} ... `);
      const a = await attemptTask(task, tier, complete);
      attempts.push(a);
      console.log(
        `${a.outcome}  ${a.model}  $${a.costUsd.toFixed(4)}  ${a.latencyMs}ms` +
          (a.gaming ? `  [${a.gaming.reasons.join(",")}]` : "") +
          (a.gateError ? `\n        ${a.gateError}` : ""),
      );
    }
  }

  const result = scoreScreen(attempts);
  console.log(`\n${"model".padEnd(26)} pass  rate   spent      $/passing task`);
  for (const s of [...result.ranked, ...result.unranked]) {
    console.log(
      `${s.model.padEnd(26)} ${String(s.passed).padStart(2)}/${s.attempts}  ` +
        `${(s.passRate * 100).toFixed(0).padStart(3)}%  ` +
        `$${s.totalCostUsd.toFixed(4).padStart(8)}  ` +
        (s.costPerPassingTaskUsd === null
          ? "     n/a (passed nothing)"
          : `$${s.costPerPassingTaskUsd.toFixed(4)}`),
    );
  }

  if (result.winner) {
    console.log(`\nCheapest per passing task: ${result.winner}`);
    if (result.savingPerTaskUsd !== null) {
      console.log(`Saves $${result.savingPerTaskUsd.toFixed(4)} per shipped change vs the dearest.`);
    }
  } else {
    console.log("\nNothing passed. No routing conclusion available from this run.");
  }
  console.log(`Total spent: $${result.totalCostUsd.toFixed(4)}`);
  console.log(
    `\nScoped gate only (typecheck + the graded tests). A pass here is not a pass\n` +
      `of the full 9-stage gate, and must not be reported as one.`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
