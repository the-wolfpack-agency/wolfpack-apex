/**
 * Publish the release covering 13-19 August 2026.
 *
 * Written by hand rather than generated: `scripts/generate-release-notes.ts`
 * falls back to commit titles when it cannot reach a model, and it could not,
 * because `vercel env pull` returns SENSITIVE values as the literal string
 * "[SENSITIVE]" and the Azure endpoint came through unusable. Commit titles
 * alone would have shipped a page of empty descriptions.
 *
 * It reuses createRelease, the same write path both release scripts use, so
 * there is one way into this table and not a second.
 */
import { createRelease, type ReleaseEntry } from "@/lib/releases";

const entries: ReleaseEntry[] = [
  {
    area: "Instinct",
    category: "feature",
    title: "The assistant can find a published article",
    description:
      "Ask for the latest on a subject and the assistant now searches public news feeds and answers with real articles, newest first, each one a link you can open. It reads a curated set of publisher feeds rather than the whole web, so it will tell you plainly when those publishers have not covered something recently, which is a different answer from finding nothing.",
    how_to_use: "Ask the assistant \"latest news on <subject>\" or \"find articles about <subject>\".",
  },
  {
    area: "Instinct",
    category: "fix",
    title: "Answers stop disappearing seconds after they arrive",
    description:
      "A reply could be replaced moments after it appeared, which read as the answer vanishing while you were still looking at it. A background refresh was overwriting what you were reading with a stored copy. What is on your screen now stays there.",
    how_to_use: "",
  },
  {
    area: "Instinct",
    category: "fix",
    title: "A question with \"today\" in it is answered, not intercepted",
    description:
      "\"What is the weather in NYC today\" came back with a list of the platform's most frequent event types. Any question containing a time word was being answered from usage statistics before it ever reached a model, and \"how do I change my account?\" qualified too, because the word \"count\" hides inside \"account\". Questions now have to be genuinely about usage to be answered that way.",
    how_to_use: "",
  },
  {
    area: "Instinct",
    category: "feature",
    title: "Pin a model, and see which one answered",
    description:
      "Start a message with /cheap, /standard or /premium to choose how much model a question gets, which is how you can prove the router reaches each one. The model that produced an answer is named beside the AI generated badge rather than written into the reply, so it can be read at a glance and never copied out with the text.",
    how_to_use: "Type /cheap, /standard or /premium at the start of a message.",
  },
  {
    area: "Instinct",
    category: "improvement",
    title: "The AI router page explains itself, and shows what was spent",
    description:
      "A five step walkthrough now shows what happens between typing a question and reading the answer, written for somebody who does not work on the platform. The honest part is the second step: most questions never reach a model at all, because they are answered from your own data at no cost. The cost figures are the provider's billed numbers rather than an estimate made before the answer existed.",
    how_to_use: "Open the AI router page under admin.",
  },
  {
    area: "Instinct",
    category: "improvement",
    title: "Named OGIAM Assistant",
    description: "The assistant is called the OGIAM Assistant everywhere it appears, including how it introduces itself.",
    how_to_use: "",
  },
  {
    area: "A Weekend with Porsche",
    category: "milestone",
    title: "Wave 1 invited: eleven Porsche Centers",
    description:
      "Waves are staged and sent from the product itself. Each wave is a card showing how many Centers it covers, how many people are still to accept, and how many have joined, with one button that invites everybody who has not accepted yet. Sending twice is safe because anybody already in is skipped. Waves 2 and 3 are locked until their dates are announced, and a locked wave has no button at all.",
    how_to_use: "Team, then the Waves panel.",
  },
  {
    area: "A Weekend with Porsche",
    category: "feature",
    title: "Add people and assign waves without leaving the product",
    description:
      "Upload the program's own spreadsheet to set which wave each Porsche Center is in, matched by PC code rather than by name, and nothing is written until you have seen exactly what would change. People can be added in bulk from a file or a pasted list, and nobody is emailed until a wave is sent. One person can now work at several Porsche Centers on a single email address.",
    how_to_use: "",
  },
  {
    area: "A Weekend with Porsche",
    category: "improvement",
    title: "The umbrella sees the whole program",
    description:
      "The umbrella account rolls up every Porsche Center beneath it: guests, handovers, completed weekends and surveys, with a Center by Center table underneath so a rolled up number can be taken back to the Center it came from. Wolfpack's own view now covers all 33 Centers instead of reading zero, and demo and test Centers are left out of every count.",
    how_to_use: "",
  },
  {
    area: "A Weekend with Porsche",
    category: "fix",
    title: "An expired session lands on sign-in, not on a page with nothing on it",
    description:
      "When a session expired the page stayed open with no navigation and no way to sign out. It now takes you to sign-in and brings you back to where you were.",
    how_to_use: "",
  },
  {
    area: "Auto",
    category: "fix",
    title: "Sign-in can no longer be redirected off-site",
    description:
      "A crafted link could send somebody to another domain immediately after they signed in, which is how a convincing phishing page gets its credibility. Sign-in now only ever returns you to a page inside the product. No password or session was ever exposed by this.",
    how_to_use: "",
  },
  {
    area: "Platform",
    category: "improvement",
    title: "Continuous integration cannot hang all day",
    description:
      "Every automated check now states how long it may take, so a stalled download fails in minutes instead of holding a change for hours, and browser installs are cached rather than fetched on every run. A check that catches an unbounded job before it merges keeps it that way.",
    how_to_use: "",
  },
];

async function main(): Promise<void> {
  const release = await createRelease({
    version: "2026.08.19",
    title: "The assistant answers from the web, and Wave 1 goes out",
    summary:
      "A week of assistant work, the first wave of Porsche Centers invited from the product itself, and a security fix on sign-in. Twelve changes across Instinct, A Weekend with Porsche, Auto and the shared build pipeline.",
    released_on: "2026-08-19",
    entries,
    published: true,
    created_by: "Nicholas Homyk",
  });
  console.log(`published ${release.version} with ${release.entries.length} entries`);
}

main().catch((err) => {
  console.error("[release] failed:", (err as Error).message);
  process.exit(1);
});
