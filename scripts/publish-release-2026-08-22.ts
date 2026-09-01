/**
 * Release report for 2026-08-22: the week the assistant learned to run a job.
 *
 * WHY A HAND-WRITTEN PUBLISHER, AGAIN
 *
 * Same reason as scripts/publish-release-2026-08-02.ts and -08-20.ts, which set
 * the precedent. The generator has an AI step that turns commit subjects into
 * plain-English breakdowns, with a documented fallback to commit-titles-only
 * when the gateway is unavailable. Run without gateway credentials it takes
 * that fallback and produces a changelog nobody can read.
 *
 * So the entries are written by hand and go through the SAME createRelease()
 * the generator uses. Reusing the write path matters more than reusing the
 * authoring step: row shape, upsert-on-version and analytics stay identical.
 *
 * Kept in the repo so the published content is reviewable in git rather than
 * existing only as a row somebody has to trust.
 *
 * Usage:  npx tsx scripts/publish-release-2026-08-22.ts [--dry-run]
 * Needs:  DATABASE_URL
 */
/* FIRST. Imports hoist, so anything below already read process.env. */
import "./load-env";
import { createRelease, type ReleaseEntry } from "@/lib/releases";

const DRY = process.argv.includes("--dry-run");
const AREA = "Instinct";

const entries: ReleaseEntry[] = [
  {
    title: "The assistant can now do a whole job, not one thing at a time",
    description:
      "Until now the assistant answered one question per message: it found the tool that matched what you typed, ran it, and stopped. That is useful and it is not what a working day looks like. A day is six of those in a row, in five different windows, with you carrying the answer from one to the next. Routines are that carrying, done for you. Type one command and it reads your calendar, collects what is open, prepares the brief for your next meeting, thinks about all three together, and stops when it needs you. Nothing is sent, filed or told to anybody without you confirming it, whether you are sitting there or not.",
    how_to_use:
      "Type 'run my morning', 'where do things stand', or 'weekly review' in the assistant. Say 'what can you do' to see everything your role can run.",
    area: AREA,
    category: "feature",
  },
  {
    title: "Describe your own day and it builds the chain for you",
    description:
      "Nobody sits down to design a workflow, and asking somebody to translate their job into our vocabulary is the work the product is supposed to be doing for them. So you describe your Monday in your own words and get it back as a plan: here is what I can already do, here is the part that is yours alone, here is where there is nothing yet. The parts that have nothing behind them are named rather than quietly dropped, because a plan that omits what it cannot do reads as full coverage and you find out at the worst moment. Say yes and the rest becomes a command you can type tomorrow.",
    how_to_use:
      "Tell the assistant what you do on a typical day, in order, in one message. Say yes when it offers to chain it. Change it later with 'remove step 3 from ...' or 'move step 4 to 1 in ...'.",
    area: AREA,
    category: "feature",
  },
  {
    title: "The steps only you can do are now counted, and they are the point",
    description:
      "Reading notes out loud before a pitch. Ringing somebody instead of emailing. Walking the floor before a review. No software can do these, and for a client-facing role they are frequently the steps that decide how the quarter went. A routine now knows the difference between checking its work and asking you to do yours, and it records whether you did it and how long it took. Skipping is recorded without penalty, deliberately: a routine that punishes a skip teaches people to tick the box, and a tick that means nothing destroys the only measurement worth having. After a handful of runs it will tell you which of your own steps is not happening, which is habitual and expensive enough to be worth a tool, and which pause is not earning its place. Always about a step, never about you.",
    how_to_use:
      "Open Routines from the left nav. The findings sit above the run history, and stay quiet until a step has run enough times to say anything honest.",
    area: AREA,
    category: "feature",
  },
  {
    title: "A routine can meet you instead of waiting to be typed",
    description:
      "A chain you have to remember still needs remembering on the morning you are busiest. Now it can run on its own and hand you the result. A scheduled run does exactly what a typed one does: it gathers, it thinks, and it stops at the first step that needs a person. It cannot send or file anything, because every write still requires confirmation and nobody is there to give it, so the worst case is a brief nobody reads rather than an email nobody meant to send. Eight in the morning means eight in your morning: the local hour and your time zone are stored and the next run is worked out against them every time, so the clocks changing does not quietly move it by an hour.",
    how_to_use:
      "Say 'run my morning every weekday at 8am'. 'What's scheduled' lists them and 'stop running my morning' ends one.",
    area: AREA,
    category: "feature",
  },
  {
    title: "A broken workflow is caught before it runs, and the fix is offered",
    description:
      "The things a workflow depends on move underneath it: a tool gets renamed, a form changes shape, somebody's access changes. Left alone the first you hear is a failed run on the morning you were counting on it. Every scheduled routine is now checked before it runs, against what actually exists today, and a broken one is not run at all: half a chain produces a partial answer that looks like a whole one. Where a step can be repaired the system works out how and asks you, naming what would change and how many steps would be left. It is never applied silently, and a replacement that does something merely similar is refused in favor of removing the step, because a workflow quietly rewired to an adjacent tool keeps running, keeps reporting success, and has stopped doing what you think it does.",
    how_to_use:
      "Nothing to do. If one of your routines breaks you will get a notification with the proposed fix; say yes to apply it or leave it and the routine stays as it is.",
    area: AREA,
    category: "feature",
  },
  {
    title: "Ready-made workflows, and only the ones that will work for you",
    description:
      "Six pre-built workflows covering meeting prep, an inbox pass, the sales pipeline, release readiness, the numbers, and the week ahead. Each is checked against what is actually connected in your workspace and what your role can run, before it is offered. So the list says which ones work for you today and which need something set up first, with the reason, rather than presenting equal-looking options that fail when you pick one. What is blocked is shown rather than hidden, because knowing what is nearly available tells you what connecting a system would buy you.",
    how_to_use:
      "Say 'show me the templates' or 'what could I automate'. Then 'use the check the pipeline workflow' to set one up.",
    area: AREA,
    category: "feature",
  },
  {
    title: "The model router now refuses what a model cannot promise",
    description:
      "The router already found and replaced passwords, keys and account numbers in both directions. That finds shapes, and it is blind to meaning: 'you'll qualify for 2.9% APR', 'that's covered under your warranty', 'there are no open recalls, it's safe to drive' contain nothing to redact and every one is a commitment the business gets held to, made by a model that cannot be. A second gate now reads what an answer SAYS before anybody sees it. Rules you can read and argue with, not a classifier, because a safety layer nobody can explain is one nobody will accept liability for. Four outcomes: let it through, trim the claim, withhold it, or hand it to a person. Rule sets are per client, with a baseline true of any business plus sets for automotive and retail.",
    how_to_use:
      "Admin, Model router shows what was refused and why, naming the rule and its reasoning rather than a count. Refusals record the rule only, never the sentence.",
    area: AREA,
    category: "feature",
  },
  {
    title: "Asking what the assistant can do is now answered by the product itself",
    description:
      "A written list of features is wrong within a week of somebody adding one, and nothing in the build catches it. It also describes what the product can do in general rather than what you can do, so a sales lead reads about the finance tools and learns about something they cannot use. The answer is now read from the live registry and filtered to your role: add a tool and it appears, remove one and it goes. It leads with the whole jobs rather than the individual tools, because a list that opens with fifty capabilities buries the thing that saves you twenty minutes.",
    how_to_use: "Type 'what can you do'. The suggestions panel in the assistant opens on the same list.",
    area: AREA,
    category: "improvement",
  },
];

async function main(): Promise<void> {
  const release = {
    version: "2026.08.22",
    title: "The week the assistant learned to run a job",
    summary:
      "The assistant stopped being a place to ask one question at a time. It now runs chains of the tools you already use, stops where only a person can decide, measures what your own steps cost you, repairs itself when one breaks, and can meet you on a schedule. The model router gained a second gate that reads what an answer says, not just what it contains.",
    released_on: "2026-08-22",
    entries,
    published: true,
    created_by: "release-report",
  };

  if (DRY) {
    console.log(JSON.stringify(release, null, 2));
    console.log(`\n[dry-run] ${entries.length} entries, nothing written.`);
    return;
  }
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set. Nothing written.");
    process.exitCode = 1;
    return;
  }
  const saved = await createRelease(release);
  console.log(`Published ${saved.version} with ${saved.entries.length} entries.`);
}

void main();
