/**
 * One-off publisher for the 2026-08-05 release report.
 *
 * WHY NOT `npm run release:notes`
 *
 * Same reason as scripts/publish-release-2026-08-02.ts: the generator's
 * plain-English step needs gateway credentials, and without them it falls back
 * to commit titles, producing a report whose every entry has an empty
 * description. The entries below are written by hand and go through the SAME
 * createRelease() the generator uses, so the row shape, the upsert-on-version
 * behaviour and the analytics are identical to a generated release.
 *
 * Kept in the repo so the published content is reviewable in git rather than
 * existing only as a row someone has to trust.
 *
 * Usage:  npx tsx scripts/publish-release-2026-08-05.ts [--dry-run]
 * Needs:  DATABASE_URL
 */
import { createRelease, type ReleaseEntry } from "@/lib/releases";

const DRY = process.argv.includes("--dry-run");
const AREA = "A Weekend with Porsche";

const entries: ReleaseEntry[] = [
  {
    title: "Analytics now shows what the guests did, not how busy the team was",
    description:
      "The analytics page counted console actions: total events, active days, a heatmap of when staff were signed in. It answered how busy a Center's own team had been, which nobody had asked. It now leads with the guest funnel: guests added, how many told you about themselves, how many had a weekend booked, and how many completed one. Each row states how many guests did not get that far, because the gap between two rows is where a weekend is won or lost. The data had been collected all along in five tables and had never once been shown to a Center.",
    how_to_use:
      "Open Analytics from the Tools section of the left nav. The funnel is the first panel. Underneath it, 'Also recorded' counts previews opened, previews watched through, surveys answered, journeys worked and stories written; those are counted across the whole program rather than per guest, so they deliberately do not add up to the funnel.",
    area: AREA,
    category: "feature",
  },
  {
    title: "Feedback has a home, and a queue behind it",
    description:
      "Program feedback and bug reports arrived by email to whoever a Center happened to know. That made one bug reported by four Centers look like four conversations rather than one priority. There is now a Feedback page under Tools, visible to every role rather than to managers only, because the people who hit a bug most are the ones working a weekend. Submissions record the page they were sent from, which is the most useful field for reproducing something and the one nobody remembers to include.",
    how_to_use:
      "Tools, then Feedback. Choose bug, idea or other, write a sentence, submit. Wolfpack staff see the triage queue on the same page and can mark items triaged or resolved. A Center only ever sees its own submissions.",
    area: AREA,
    category: "feature",
  },
  {
    title: "The dealer workspace is four pages instead of one long scroll",
    description:
      "The introduction, the guest workspace and Success Stories were three sections stacked on one very long page. A Center wanting the guest list scrolled past the program carousel every time, and there was no link you could send a colleague that landed anywhere but the top. Stories in particular are written after a weekend, often by someone not otherwise in the tool that day.",
    how_to_use:
      "The left nav now carries Introduction, Dealer Dashboard, Communication Builder and Submit Your Story as separate pages, each with its own address you can send to someone. The six journey stages sit below them as numbered steps.",
    area: AREA,
    category: "improvement",
  },
  {
    title: "Analytics reads in English",
    description:
      "The activity chart rendered raw internal event names to a Porsche Center: admin.guest_created, guest.deck_opened. It now uses the same plain-English phrasing the activity feed already used, rather than a second wording that could drift from it.",
    how_to_use: "No action needed. The chart on Analytics reads in plain language.",
    area: AREA,
    category: "improvement",
  },
  {
    title: "Deploys apply their own database migrations again",
    description:
      "A schema change could ship ahead of the code that needed it, because the deploy skipped migrations whenever it lacked an owner-level connection, and warned rather than failing. That is how one feature reached production against a table that did not exist yet. The deploy now runs migrations with an owner connection, separate from the credentials the running app uses, so the app itself still cannot alter the schema.",
    how_to_use:
      "No action needed. Deploy logs state which database shape they connected to and whether migrations ran, so a skipped migration is visible rather than silent.",
    area: AREA,
    category: "fix",
  },
  {
    title: "An intermittent rendering error is gone from the dealer portal",
    description:
      "Pages in the dealer portal intermittently logged a React hydration error. It came from three separate causes wearing one error code: styles declared inside components rather than in the stylesheet, a script inserting an element into a page after it had been sent, and checks that ran before a page had finished loading. All three are fixed, and each now has an automated check that fails if it returns.",
    how_to_use:
      "No action needed. The portal no longer logs the error, and three new checks run on every change.",
    area: AREA,
    category: "fix",
  },
  {
    title: "Guest re-import updates a guest instead of silently doing nothing",
    description:
      "The CSV panel promised that re-importing an updated file refreshes existing guests rather than duplicating them. The importer skipped rows it had seen before, so a Center fixing a typo and re-uploading saw a success message and no change. Re-importing now updates the guest, and a column the new file leaves out keeps its stored value rather than being blanked.",
    how_to_use:
      "Dealer Dashboard, Add New Guest, Import CSV. The summary reports how many guests were created and how many were refreshed.",
    area: AREA,
    category: "fix",
  },
  {
    title: "Vehicle of interest is optional, as the panel always said it was",
    description:
      "The CSV panel described the vehicle column as optional while the importer rejected any row without it. The importer now matches the promise.",
    how_to_use: "Import a CSV with or without a vehicle column; both are accepted.",
    area: AREA,
    category: "fix",
  },
];

async function main(): Promise<void> {
  const payload = {
    version: "2026.08.05",
    title: "Guest analytics, feedback, and a portal split into four pages",
    summary:
      "The analytics page now leads with what happened to a Center's guests rather than how many times its team clicked. Feedback gets a page and a triage queue. The dealer workspace splits into four addressable pages. Plus the deploy applies its own migrations again, guest re-import actually updates a guest, and an intermittent rendering error is gone.",
    released_on: "2026-08-05",
    entries,
    published: true,
  };

  if (DRY) {
    console.log(JSON.stringify(payload, null, 2));
    console.log(`\ndry run: ${entries.length} entries, nothing written.`);
    return;
  }

  const release = await createRelease(payload);
  console.log(`published ${release.version}: ${entries.length} entries`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
