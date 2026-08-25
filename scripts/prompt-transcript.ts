/**
 * Type at the assistant and read back exactly what a client would see.
 *
 * WHY THIS EXISTS ALONGSIDE THE OTHER TWO
 *
 * phrase-sweep answers "which tool claims this phrasing" over hundreds of
 * phrasings in a second, and cannot tell you whether the answer was any good.
 * conversation-probe drives a running deployment like a person, and needs a
 * URL and a login, which has blocked it more often than it has run.
 *
 * Neither shows you the thing that actually matters before a demo: the words
 * on the screen. This runs the real chat() in process, so it needs no
 * deployment, no login and no tunnel, and prints the answer verbatim.
 *
 * Every conversational bug this quarter was found by reading an answer, not by
 * reading a test: a step counter that said "1 of 4" twice, a plan that claimed
 * it could do nothing three lines after saying it could, a meeting at 5pm that
 * was at 1pm, a question about briefs answered with brand-ambassador training.
 * A green suite reported health through all of it.
 *
 * WHAT IT COSTS. Most prompts never reach a model, which is the product
 * working as designed. The ones that do are charged at the cheap tier. A full
 * run of the default set is fractions of a cent.
 *
 * Usage:
 *   npx tsx scripts/prompt-transcript.ts                 # the default set
 *   npx tsx scripts/prompt-transcript.ts --only calendar # matching prompts
 *   npx tsx scripts/prompt-transcript.ts --file my.txt   # one prompt per line
 *   npx tsx scripts/prompt-transcript.ts "is CI green"   # one prompt
 *   npx tsx scripts/prompt-transcript.ts --quiet         # headers only
 *
 * Needs: DATABASE_URL. Set AI keys to exercise the paths that reach a model;
 * without them those answers degrade honestly, which is itself worth seeing.
 */
import { readFileSync } from "node:fs";
import { chat } from "@/lib/assistant";

/* Grouped by what each one is there to catch, so a failure points at the
   thing that broke rather than at "the assistant". */
const SET: Array<{ group: string; prompts: string[] }> = [
  {
    group: "The front door",
    prompts: ["what can you do", "what can you help me with", "where do I start"],
  },
  {
    group: "Describing a day, which becomes a chain",
    prompts: [
      "here is what I do each Monday: I check email, then I run standup, then I chase the overnight leads",
      "every morning I read my email, check the calendar and chase the overnight leads",
    ],
  },
  {
    group: "Calendar, in the caller's own clock",
    prompts: [
      "open my calendar",
      "what does my week look like",
      "what's on my calendar for tomorrow",
      "am I free Friday afternoon",
    ],
  },
  {
    group: "Build and backlog, which name no repository",
    prompts: ["is CI green", "did the build pass", "any open issues", "what is waiting for review"],
  },
  {
    group: "Stock, in the words a dealer uses",
    prompts: ["what vehicles are available", "how many Cayennes are on the lot"],
  },
  {
    group: "Routines",
    prompts: ["run my morning", "where do things stand", "start my day"],
  },
  {
    group: "The knowledge base",
    prompts: [
      "what does the brand ambassador training cover",
      "what is our policy on time off",
    ],
  },
  {
    group: "Things it should refuse, or ask about, rather than answer",
    prompts: [
      "what issues are assigned to me",
      "yes please",
      "the assistant icon doesn't appear on the messages page",
    ],
  },
];

function selected(): Array<{ group: string; prompt: string }> {
  const argv = process.argv.slice(2);
  const fileArg = argv.indexOf("--file");
  if (fileArg !== -1 && argv[fileArg + 1]) {
    return readFileSync(argv[fileArg + 1], "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"))
      .map((prompt) => ({ group: "From file", prompt }));
  }
  const onlyArg = argv.indexOf("--only");
  const only = onlyArg !== -1 ? (argv[onlyArg + 1] ?? "").toLowerCase() : "";
  const bare = argv.filter((a) => !a.startsWith("--") && argv[argv.indexOf(a) - 1] !== "--only" && argv[argv.indexOf(a) - 1] !== "--file");
  if (bare.length > 0) return bare.map((prompt) => ({ group: "Given", prompt }));

  const flat = SET.flatMap((s) => s.prompts.map((prompt) => ({ group: s.group, prompt })));
  return only
    ? flat.filter((p) => p.group.toLowerCase().includes(only) || p.prompt.toLowerCase().includes(only))
    : flat;
}

const QUIET = process.argv.includes("--quiet");

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is required: this runs the real pipeline, not a mock.");
    process.exit(1);
  }
  const items = selected();
  const user = process.env.TRANSCRIPT_USER_ID ?? "transcript-probe";
  const role = process.env.TRANSCRIPT_USER_ROLE ?? "cto";

  let group = "";
  let tokens = 0;
  let free = 0;

  for (const item of items) {
    if (item.group !== group) {
      group = item.group;
      console.log(`\n\n${"=".repeat(72)}\n${group}\n${"=".repeat(72)}`);
    }
    const started = Date.now();
    let answer = "";
    let used = 0;
    let source = "";
    try {
      const res = await chat(item.prompt, user, role, undefined, undefined, "default");
      answer = res.response ?? "";
      used = res.tokensUsed ?? 0;
      source = res.source ?? "";
    } catch (err) {
      answer = `THREW: ${(err as Error).message}`;
    }
    tokens += used;
    if (used === 0) free += 1;

    const ms = Date.now() - started;
    console.log(`\n> ${item.prompt}`);
    console.log(`  [${source || "?"} · ${used} tokens · ${ms}ms]`);
    if (!QUIET) {
      console.log("");
      for (const line of answer.split("\n")) console.log(`  ${line}`);
    }
  }

  console.log(
    `\n\n${items.length} prompts. ${free} answered without reaching a model. ${tokens} tokens total.`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
