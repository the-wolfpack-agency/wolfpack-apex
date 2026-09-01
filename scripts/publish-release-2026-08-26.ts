/**
 * Release report for 2026-08-26: the week the assistant stopped saying things
 * that were not true.
 *
 * WHY A HAND-WRITTEN PUBLISHER, AGAIN
 *
 * Same reason as -08-02, -08-20 and -08-22, which set the precedent. The
 * generator's AI step turns commit subjects into plain-English breakdowns and
 * falls back to commit-titles-only without gateway credentials, which produces
 * a changelog nobody can read. The entries are written by hand and go through
 * the SAME createRelease() the generator uses, so row shape, upsert-on-version
 * and analytics stay identical.
 *
 * THE SHAPE OF THIS RELEASE. Almost every entry is a correction rather than a
 * feature, and they share one cause: something reported health it did not
 * have. A tally counted on a different basis from the total beside it. A judge
 * that was built, measured, quoted in a pull request and never called. A
 * connector that met a rate limit, recorded 873 failures and was never run
 * again. Written as what somebody would notice, because that is what they saw.
 *
 * Usage:  npx tsx scripts/publish-release-2026-08-26.ts [--dry-run]
 * Needs:  DATABASE_URL
 */
/* FIRST. Imports hoist, so anything below already read process.env. */
import "./load-env";
import { createRelease, type ReleaseEntry } from "@/lib/releases";

const DRY = process.argv.includes("--dry-run");
const AREA = "Instinct";

const entries: ReleaseEntry[] = [
  {
    title: "Meeting times now read in your clock, not the server's",
    description:
      "A one o'clock meeting was reported as five o'clock. Your browser has been sending its timezone on every message all along, and it reached one half of the assistant and stopped there: asking about your calendar in a sentence was right, while the identical lookup inside a routine was four hours out. Both paths now use your zone, and the day a meeting belongs to is your day rather than Greenwich's, so an eight o'clock evening meeting no longer lands on tomorrow's date.",
    how_to_use:
      "Ask 'what's on my calendar for tomorrow' or run 'start my day'. Times read in your local zone with no setting to change.",
    area: AREA,
    category: "fix",
  },
  {
    title: "A paused routine keeps count of your work",
    description:
      "A four-step chain said '1 of 4 steps done' after step one, you did step two and told it so, and it said '1 of 4 steps done' again. It was counting the steps it ran and comparing them to a total that included yours, so the number could never reach the end and did not move when you did the very thing it asked for. Your steps now count. The chain also finishes with the number of steps that actually happened rather than only the ones it performed itself.",
    how_to_use:
      "Run any routine with a step that is yours. Say 'done' when you have done it, or 'skip' if you are not going to. Both are recorded.",
    area: AREA,
    category: "fix",
  },
  {
    title: "Every routine can now be finished, not just started",
    description:
      "Eleven of the fourteen routines could be started and never completed. A run records which routine it belongs to, and the lookup that reads it back searched only the three built-in ones, so coming back to say 'done' on any of the other eleven was answered with 'that routine does not exist any more' after you had already done the work. Nothing was ever lost, but there was no way to tell that from what it said.",
    how_to_use:
      "Any routine that pauses for you can now be resumed with 'done', 'carry on' or 'skip'.",
    area: AREA,
    category: "fix",
  },
  {
    title: "The plan of your day no longer contradicts itself",
    description:
      "Describe your Wednesday and the plan listed your steps, said it could do two of them, and then said it could do none of them and had left them out, three lines below printing them as items one and three. Three untrue statements in four lines, each visible to the person reading. It was counting several unrelated things as one number: a tool that needs a detail, a tool your role cannot run, and something genuinely missing are now counted and described separately, so the numbers add up to the list above them.",
    how_to_use:
      "Tell the assistant what you do on a typical day, in order, in one message.",
    area: AREA,
    category: "fix",
  },
  {
    title: "'Check my email' can be part of a chain now",
    description:
      "The commonest step anybody describes could not be automated. Mail search needs at least one of a sender, a recipient or a topic, and that rule spans three fields rather than belonging to any one of them, so the planner had nothing specific to ask for and left the step out. It read as 'I cannot check your email'. A tool can now name the question it needs answered, and the mail step asks what to look for when it runs.",
    how_to_use:
      "Include 'I check my email' when you describe your day. The chain will ask what to look for at that step.",
    area: AREA,
    category: "improvement",
  },
  {
    title: "The knowledge base stops answering with the wrong document",
    description:
      "A question about meeting briefs came back with three chunks of Porsche brand-ambassador training material, at full confidence. Every check it passed was a check about shape: how many results, what score, how long the question was. A confident wrong answer passes all of them because it reads perfectly. A judge that can tell whether the material actually answers the question now runs before anything is quoted, and when the answer is no, the material is dropped rather than handed to a model that would repeat it with our confidence.",
    how_to_use:
      "Ask the assistant anything the Brain might know. Irrelevant retrievals are now withheld rather than quoted.",
    area: AREA,
    category: "fix",
  },
  {
    title: "The SharePoint connector survives a rate limit",
    description:
      "The library sync ran once, in May, and stopped. Microsoft throttles bulk downloads, and the connector treated being throttled as a permanent failure: one run recorded 873 files failed, almost every one of them rate-limited, and jobs were being killed by a six-minute ceiling. So the document library never arrived, which is why the knowledge base has been full of journals and receipts while people ask product questions. It now waits out a throttle and obeys the delay Microsoft asks for, and remembers which files it already took so a second run continues instead of starting again.",
    how_to_use:
      "Admin, Connectors, SharePoint. Add a source and sync. A run that is interrupted can simply be run again.",
    area: AREA,
    category: "fix",
  },
  {
    title: "Questions the assistant needs answered are buttons now",
    description:
      "When a question does not carry everything a tool needs, the assistant asks rather than guessing at it. Guessing is how you get a confident answer about a repository nobody mentioned. Asking in prose, though, is a list of things to retype, and retyping is where people give up. The questions are now one tap: pick the answer and it re-sends your own question with the missing piece filled in.",
    how_to_use: "Ask 'is CI green' and pick a repository from the buttons.",
    area: AREA,
    category: "feature",
  },
  {
    title: "Twenty more ways of asking now reach the right tool",
    description:
      "Every phrasing anybody is likely to type is now run through the real matchers on every build, rather than found one at a time by somebody hitting it. That sweep found the calendar answering 'open calendar' but not 'open my calendar'; a dealer asking what is on the lot getting nothing, because the product knew the words inventory and stock but not the words people say; a question about CI answered with a list of deployments; and a description of somebody's working morning answered with a list of database records. Some phrasings are deliberately still refused: 'what issues are assigned to me' cannot be answered correctly yet, and answering it with everything in the org would be worse than saying nothing.",
    how_to_use:
      "Try 'open my calendar', 'what vehicles are available', 'is CI green', 'any open issues', 'what is waiting for review'.",
    area: AREA,
    category: "improvement",
  },
];

async function main(): Promise<void> {
  const release = {
    version: "2026.08.26",
    title: "The week the assistant stopped saying things that were not true",
    summary:
      "Almost everything here is a correction, and they share one cause: something reported health it did not have. A tally counted on a different basis from the total printed beside it. A relevance judge that was built, measured, quoted in a pull request and never actually called. A document connector that met a rate limit, recorded 873 failures and was never run again. None of it showed up as a failure anywhere, which is exactly why it lasted. The assistant now counts your work, finishes what it starts, reads times in your clock, refuses to quote a document that does not answer your question, and asks with buttons when it needs one more thing from you.",
    released_on: "2026-08-26",
    entries,
    published: true,
    created_by: "release-report",
  };

  if (DRY) {
    console.log(JSON.stringify(release, null, 2));
    console.log(`\n[dry-run] ${entries.length} entries, nothing written`);
    return;
  }
  const out = await createRelease(release);
  console.log(`[release] published ${out.version} with ${entries.length} entries`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
