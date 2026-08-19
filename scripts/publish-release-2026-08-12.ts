/**
 * One-off publisher for the 2026-08-12 release report.
 *
 * WHY NOT `npm run release:notes`
 *
 * Same reason as the 2026-08-02 and 2026-08-05 publishers: the generator's
 * plain-English step needs gateway credentials, and without them it falls back
 * to commit titles, producing a report whose every entry has an empty
 * description. This release is 89 commits, so that fallback would be a wall of
 * subject lines nobody reads.
 *
 * The entries below are written by hand and go through the SAME createRelease()
 * the generator uses, so the row shape, the upsert-on-version behaviour and the
 * analytics are identical to a generated release.
 *
 * Kept in the repo so the published content is reviewable in git rather than
 * existing only as a row someone has to trust.
 *
 * SIZE, measured rather than estimated (2026-08-06..2026-08-12, lock files and
 * generated CSS excluded because a dependency bump otherwise reports tens of
 * thousands of lines and buries the real number):
 *   wolfpack-porsche-weekend  87 commits, 122 files, +11,537 / -1,163
 *   wolfpack-apex              2 commits,   4 files,    +214 /    -24
 *
 * Usage:  npx tsx scripts/publish-release-2026-08-12.ts [--dry-run]
 * Needs:  DATABASE_URL
 */
import { createRelease, formatDiffStat, type DiffStat, type ReleaseEntry } from "@/lib/releases";

const DRY = process.argv.includes("--dry-run");
const AREA = "A Weekend with Porsche";

const SIZE: DiffStat = { commits: 89, files: 126, insertions: 11751, deletions: 1187 };

const entries: ReleaseEntry[] = [
  {
    title: "The guest checklist moved onto the client profile",
    description:
      "Working a guest through their weekend meant pressing a small check button on their row in the list, which opened the item-level checklist in a drawer under it. That put the detail on the screen that summarises every guest, and left the profile, the screen for working one guest, with stage tiles and no items. The grid view could not reach it at all. All six stages now sit on the profile itself as cards, three to a view, between the guest's details and their questionnaire. Check All and Uncheck All replace the single toggle that changed meaning as you ticked the last box.",
    how_to_use:
      "Open any guest from the list. The Checklist section is below their contact details and vehicle. Tick items directly, or use Check All on a stage. Completing a stage still completes the ones before it and clearing one still clears the ones after, because a weekend runs in order.",
    area: AREA,
    category: "feature",
  },
  {
    title: "A race that recorded a guest as handed a car they were never given",
    description:
      "Opening a guest fires a request for their saved progress. Pressing Check All before it landed let the stale response overwrite the write, and the damage was worse than a lost tick: the stage you pressed was wiped while the cascade that followed filled the two stages BEFORE it. The record then said a guest had returned from an experience that had been cleared. A guard for this already existed for the stage tiles; the new checklist had stepped outside it. Found by driving the real UI, not by any unit test.",
    how_to_use:
      "Nothing to do. Ticks made immediately after opening a guest are now kept, however slow the connection.",
    area: AREA,
    category: "fix",
  },
  {
    title: "The six stage pages are a reference again, not a second checklist",
    description:
      "Each stage page carried its own tickable copy of the same eight items, writing to the same row as the profile. A DBC could tick in one place, tick in the other, and have one silently overwrite the other with nothing on screen saying which had won. The stage pages now show the items as a static reference: the icons and labels stay, the check badges, the progress bar and the Complete all button are gone. The guest bar and the chooser that asked 'Who is this journey for?' went with them, because they existed to attach a guest so the checklist would save, and it no longer does.",
    how_to_use:
      "Use the stage pages to read what a stage involves. Record a guest's progress on their profile, which is now the only place that writes.",
    area: AREA,
    category: "feature",
  },
  {
    title: "A support page for the Porsche Center leads",
    description:
      "The Wave 1 leads collect issues from their own staff and had nowhere to send them. /admin/support is a form behind the same sign-in they already use, so it knows who is submitting and for which Center and does not ask. Every submission lands in the same queue as in-product feedback and is emailed to the team. Four fields are required and each earns it: type has no default, because a pre-selected radio is the value most submissions arrive with whether or not it is true; a one-line summary, because it becomes the email subject; urgency, because whether a guest is stuck right now cannot be inferred from prose written by somebody being polite; and the report itself.",
    how_to_use:
      "Send the leads https://weekendwithporsche.com/admin/support. It is unlisted, so there is no nav link. Feedback from inside the product still goes to /admin/feedback and reaches a shorter list.",
    area: AREA,
    category: "feature",
  },
  {
    title: "Invitation email can be trusted to arrive",
    description:
      "The sending domain published an SPF record ending in -all that did not list Microsoft's outbound, and no DKIM selectors at all, so every invitation to the eleven Centers would have gone out unauthenticated. Nothing caught it: no test looked at DNS, and the in-product self-test could not, because it mails an address in our own tenant, where Exchange evaluates neither SPF nor DKIM. Both are now fixed and verified against the authoritative nameservers, and launch:check reads them on every run.",
    how_to_use:
      "Run npm run launch:check. It reports SPF, its lookup budget against the RFC limit of 10, both DKIM selectors and DMARC alongside the page and header checks.",
    area: AREA,
    category: "fix",
  },
  {
    title: "The PPN export is accepted as downloaded, and keeps what it knows",
    description:
      "The Porsche Partner Network export carries 29 columns and the importer kept three: first name, last name, email. Everything else was read and dropped, including the one thing the whole program is scheduled around, when the guest has the car. The team were asking why the intake template did not match theirs. The file now imports as downloaded, and the booked window, the Porsche booking status, the attendee count and the guest names are kept. A guest imported from it starts with the Invitation stage complete, because being in that file means they were invited.",
    how_to_use:
      "Import CSV on the guest workspace, and drop the PPN file in unmodified. The booking appears on the guest's profile under their vehicle. Home address and date of birth are deliberately not stored: the program has no use for them and the privacy notice says they are not collected.",
    area: AREA,
    category: "feature",
  },
  {
    title: "Terms and Privacy published, and every claim checked against the system",
    description:
      "Both documents were a draft skeleton behind a banner saying so. They are now published with an effective date, and every factual statement was written against a data map read off the migrations rather than from memory: the fields collected, the two cookies, the three places data leaves. Retention states what actually happens, that data is kept until deleted, rather than a schedule no job enforces. The support address they advertised pointed at a domain with no MX records, so it received nothing; it now points at one that does, and is a link. Three clauses a commercial agreement normally carries are deliberately absent, listed for counsel.",
    how_to_use:
      "Terms and Privacy are linked in the footer of every page and open without signing in.",
    area: AREA,
    category: "feature",
  },
  {
    title: "Analytics counts the weekend, not the console",
    description:
      "The funnel measured a status ladder nothing advanced, so Centers with completed weekends read zero. It now counts what the workspace records: booked, told you about themselves, car handed over, weekend completed. The charts became readable rather than decorative, with working tooltips. Two rows counting a preview that does not exist were removed, along with the queries behind them, because a row that can only ever read zero teaches a reader the panel is broken.",
    how_to_use:
      "Analytics is in the Tools section of the left nav. The guest funnel is the first panel.",
    area: AREA,
    category: "fix",
  },
  {
    title: "A launch readiness check, and a way to verify the deployed page",
    description:
      "Two checks that answer questions a test suite cannot. launch:check is read-only against production: the four pages an invited dealer must reach, the demo door, security headers, the legal pages and the sending domain's DNS. verify:live-ui drives production in a real browser and screenshots it, because 'the tests passed' has never been the same claim as 'it works on the deployed URL'. It earned its place on the first run by catching two false greens in itself.",
    how_to_use:
      "npm run launch:check before inviting anyone, and again immediately before. npm run verify:live-ui after a deploy; screenshots land in test-results/live-ui.",
    area: AREA,
    category: "feature",
  },
  {
    title: "A guardrail for the build failure that type-checking cannot see",
    description:
      "A client component that imports anything reaching the Postgres driver pulls node's net and tls into the browser bundle and fails the production build. Type-checking does not catch it and neither does any unit test; it surfaces minutes later inside next build. A check now walks the import graph and fails when a 'use client' file value-imports one of those modules, with type-only imports allowed because they are erased before bundling. It found a pre-existing case that survived only because the bundler happened to tree-shake it away.",
    how_to_use:
      "It runs as part of npm run verify. A failure names the file and the module it reached.",
    area: "Instinct",
    category: "feature",
  },
  {
    title: "Release notes can describe work that shipped in another repo",
    description:
      "/releases is the org-wide changelog but the generator could only read the repo it lives in, so a week of work in porsche-weekend, beyond or auto could not be published from it. --repo reads another checkout, validated up front rather than silently describing the wrong commits. Each release now also states its own size, measured over the same commit range it describes, with lock files and minified output excluded so a dependency bump does not bury the real number.",
    how_to_use:
      "npm run release:notes -- --repo=../wolfpack-porsche-weekend --since=<ref>. Add --entries to publish curated notes through the same path, and --dry-run to see the JSON without writing.",
    area: "Instinct",
    category: "feature",
  },
  {
    title: "Design review: the client profile, the dashboard and the mobile faults",
    description:
      "A round of supplied-design work and reported faults. The client profile and Success Stories were rebuilt to the mockups. Vehicle photos were normalised to one scale so a 718 owner no longer sees a Cayenne. Stage tiles became menus offering Go to Overview or Mark as Completed, and completed reads black rather than grey. On a phone, the stage menu no longer runs off the screen and Delete permanently no longer wraps. The dropdown chevron came back on Vehicle Preference, the duplicate footer went, and the questionnaire box is open by default like every other field on the form.",
    how_to_use:
      "Open any guest from the workspace to see the profile.",
    area: AREA,
    category: "fix",
  },
];

async function main(): Promise<void> {
  const payload = {
    version: "2026.08.12",
    title: "Launch week: the checklist moves to the profile, support opens, and email can be trusted",
    summary:
      `The week before eleven Porsche Centers are invited. The item-level checklist moved onto the client profile and the six stage pages became a reference, so there is one place that records a guest's progress rather than two that could overwrite each other. A support page opened for the Center leads. The sending domain could not authenticate a single invitation and now can. The PPN export imports as downloaded and keeps the booking. Terms and Privacy are published against a data map read off the schema. ${formatDiffStat(SIZE)}`,
    released_on: "2026-08-12",
    entries,
    published: true,
  };

  if (DRY) {
    console.log(JSON.stringify(payload, null, 2));
    console.log(`\ndry run: ${entries.length} entries, nothing written.`);
    console.log(formatDiffStat(SIZE));
    return;
  }

  const release = await createRelease(payload);
  console.log(`published ${release.version}: ${entries.length} entries`);
  console.log(formatDiffStat(SIZE));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
