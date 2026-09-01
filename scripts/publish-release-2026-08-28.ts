/**
 * Publish the 2026-08-28 release notes.
 *
 * Same write path as the generator, so row shape, upsert-on-version and
 * analytics stay identical. Kept in the repo so the published content is
 * reviewable in git rather than existing only as a row somebody has to trust.
 *
 * WHAT THIS RELEASE IS. A day spent measuring the product against production
 * rather than against its own tests, and fixing what that found. Every entry
 * below is a thing that was wrong in front of real users, with the number that
 * proved it. Written for the person using the product, not for the person who
 * changed it.
 *
 * Usage:  npx tsx scripts/publish-release-2026-08-28.ts [--dry-run]
 * Needs:  DATABASE_URL
 */
/* FIRST. Imports hoist, so anything below already read process.env. */
import "./load-env";
import { createRelease, type ReleaseEntry } from "@/lib/releases";

const DRY = process.argv.includes("--dry-run");
const AREA = "Instinct";

const entries: ReleaseEntry[] = [
  {
    title: "It no longer tells you it cannot do things it can",
    description:
      "Asked \"can you send an email for me\", the assistant used to answer \"I cannot send emails directly\". Asked what files it could see, it said it had no access to your files and offered to look at code snippets. Both were false, and both came back instantly from a saved answer rather than from thinking, because months ago a model said them once and the product wrote them down as facts. Sixteen of those saved refusals have been removed, and questions about what it can do are now answered by reading the actual list of things it can run for your role.",
    how_to_use:
      "Ask \"can you send an email for me\" or \"what files can you see\". You will get a yes and the specific things it can do, in about a second, instead of an apology.",
    area: AREA,
    category: "fix",
  },
  {
    title: "SharePoint search worked for the first time since May",
    description:
      "Every SharePoint search had failed for nearly four months. 171 attempts, every one refused, while the sign-ins behind them refreshed successfully 15,855 times. The cause was a request asking Microsoft for three kinds of thing when the permission we hold covers one, and Microsoft refuses the whole request rather than answering the part it can. It now asks only for documents, which needs no extra admin approval, and search reaches your document libraries directly without a copy being taken.",
    how_to_use:
      "Search for a file by name, or ask what documents you have about a subject. Results link to the file in your own SharePoint.",
    area: AREA,
    category: "fix",
  },
  {
    title: "Search is no longer a twenty-second wait",
    description:
      "Two searches were reported taking twenty seconds, which reads as broken however good the answer is. Measuring every source over a week found one was responsible: Teams channel search averaged five and a half seconds, took twenty-two at its slowest ninetieth, and once took over two minutes, while every other source finished inside three and a half seconds even at its worst. Because sources are searched at the same time, the slowest one was the whole search. Any single source now has six seconds before the rest go ahead without it, and one that runs out of time is recorded as slow rather than as having found nothing.",
    how_to_use:
      "Search as normal. If one system is having a bad day you get everything else without waiting for it.",
    area: AREA,
    category: "improvement",
  },
  {
    title: "\"You have no open tasks\" is only said when it is true",
    description:
      "The task list was read from a local copy of your Microsoft tasks that nothing had ever filled: not one row, for any person, ever. Every reader was told they had no open tasks regardless of what was actually in their list, cheerfully and with no way to tell. Tasks are now read from Microsoft at the moment you ask, so nothing is copied, nothing goes stale, and an empty list means Microsoft was asked and said so.",
    how_to_use:
      "Ask \"how many open tasks do I have\" or \"what is waiting on me\".",
    area: AREA,
    category: "fix",
  },
  {
    title: "Six questions people actually type now reach the right place",
    description:
      "\"How many open tasks do I have\" reached nothing and was answered with a screenshot and two training PDFs about flipcharting your day. \"Who runs engineering\" was answered from a client's brand-ambassador slides while our own staff list sat one table away. \"What documents do we have about PCNA\" said it had no confident answer while that client's entire library was indexed. \"Wolfpackxpcna\" was typed thirteen times in sixty days and answered nothing every time, and it is the name of a SharePoint site. All six now answer, and a test runs over every starter prompt for all fourteen roles to check each one reaches something that role is allowed to use.",
    how_to_use:
      "Ask them in your own words. \"Whats our policy on pto\" works as well as \"find the pto policy\" now.",
    area: AREA,
    category: "fix",
  },
  {
    title: "A revenue figure is no longer mistaken for a phone number",
    description:
      "An answer about the company's North Star target read \"Hit $1B in Revenue = [PHONE_1] $\". The privacy filter treated any bare ten-digit number as a phone number, so revenue targets, invoice totals and record counts were all blanked out mid-sentence. Real phone numbers cannot begin with a zero or a one in their area code, so the filter now uses that rule to tell a number somebody could dial from a number somebody is reporting. Every genuine phone format is still removed.",
    how_to_use: "Ask about a figure with a large round number in it and read the answer.",
    area: AREA,
    category: "fix",
  },
  {
    title: "The product checks itself every night",
    description:
      "All of the above were found by typing questions at the live product and reading the answers, which is not something that happens on a schedule unless something schedules it. Now six of those questions are asked automatically every night, through the same path a person uses, and the answers are checked for the specific ways they were wrong before. A separate check exercises the Microsoft connection, which had been reporting for months without a single successful run.",
    how_to_use:
      "Nothing to do. If something breaks overnight it is recorded by morning rather than discovered by whoever asks first.",
    area: AREA,
    category: "feature",
  },
  {
    title: "You can see who is actually using it, including who never started",
    description:
      "The pilot page reports how many people were given access, how many have ever asked anything, how many are active this week, how many started and drifted away, and the questions people asked more than once and never got an answer to. On our own data that last list is led by somebody typing the same misspelled search thirty-six times. It is deliberately unflattering: anyone can report active users, and the three that matter are the ones you otherwise discover at the end of a pilot.",
    how_to_use: "Open the pilot page.",
    area: AREA,
    category: "feature",
  },
  {
    title: "It can now answer questions about your own systems without being asked",
    description:
      "A new set of questions runs against whatever you have connected and comes back with findings rather than a search box: what is in your documents about onboarding, what a contract says about payment terms, who is on the team, what is on this week. Everything runs as you, so it only ever sees what you can see, and a question that comes back empty is reported as empty rather than quietly dropped, because the gaps are the useful part.",
    how_to_use: "Coming to the dashboard. The questions and answers are already live behind it.",
    area: AREA,
    category: "feature",
  },
];

async function main() {
  const version = "2026.08.28";
  const title = "The week the product started checking its own answers";
  const summary =
    "A day of measuring the product against production instead of against its own tests. " +
    "SharePoint search had been failing since May, the task list told everybody they had nothing, " +
    "the assistant denied capabilities it has, and search took twenty seconds. All fixed, all with " +
    "the numbers that found them, and the product now re-asks those questions every night so the " +
    "next regression is caught by morning rather than by a client.";

  if (DRY) {
    console.log(`[release] DRY RUN ${version}: ${entries.length} entries`);
    for (const e of entries) console.log(`  - [${e.category}] ${e.title}`);
    return;
  }

  const created = await createRelease({
    version,
    title,
    summary,
    released_on: "2026-08-28",
    entries,
    published: true,
    created_by: "release-script",
  });
  console.log(`[release] published ${created.version} with ${entries.length} entries`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
