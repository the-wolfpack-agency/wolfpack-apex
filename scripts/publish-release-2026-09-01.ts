/* FIRST. Imports hoist, so anything below already read process.env. */
import "./load-env";

/**
 * The 2026-09-01 release: the day the product started proving its own claims.
 *
 * Written from the eighteen pull requests that merged, not from memory. The
 * through-line is worth stating plainly because it is the same finding
 * eighteen times: capabilities that were built, tested, configured and had
 * never once run. OCR, query expansion, the document repair, the retrieval
 * eval, the calendar calibration. None of them failed loudly, because a
 * capability nothing exercises does not degrade. It simply never was.
 *
 * Entries are written for somebody who was not here. "Fixed the repair sweep"
 * means nothing; "the nightly job reported success while repairing nothing for
 * weeks" is the fact a reader can do something with.
 */

import { createRelease, type ReleaseEntry } from "@/lib/releases";

const ENTRIES: ReleaseEntry[] = [
  {
    title: "Scanned documents are readable for the first time",
    description:
      "A photographed agreement or an exported slide carries no text, so it indexed as a filename and answered nothing. The OCR route to read them was built months ago, wired into the repair with a cost policy and an audit trail, and had run zero times: a scan fails with 'no extractable text', and that phrase was missing from the list of things worth retrying. Seventeen documents are now readable, averaging 1,634 characters each, including a skills-practice deck of 19,340.",
    how_to_use:
      "Nothing to do. The nightly repair picks them up. The Phase One page reports how many scans were recovered as its own figure, separate from the passage count, because a scan that indexes as a filename looks identical on a dashboard to a document that was read.",
    area: "Instinct",
    category: "feature",
  },
  {
    title: "The document repair had never repaired anything",
    description:
      "It ran nightly for weeks and reported success. Three separate faults: it asked for fifty documents and the query applied that limit before filtering to the ones it could fix, so it usually selected none; the identity it ran as could never hold a Microsoft token, so downloads always failed; and when a download failed it overwrote the diagnosis that made the document repairable, permanently shrinking its own work queue one batch per night. The library went from 884 indexed documents to 982 once all three were fixed.",
    how_to_use:
      "Runs nightly. A run that takes documents and repairs none of them now exits non-zero and says to check the Microsoft connection, rather than showing a green tick.",
    area: "Instinct",
    category: "fix",
  },
  {
    title: "A register of what we claim, and what has ever done it",
    description:
      "Four capabilities turned out to be built, tested, configured in production and never run, each found by accident weeks late while chasing something else. The register asks a different question from a test: not does this work, but has it ever done its job on real data. Evidence is a trace the system leaves when it works, never a self-report, because a configured credential and a passing test were both true of all four.",
    how_to_use:
      "Runs daily and fails only when something has never run. Seven capabilities on it today, all demonstrated.",
    area: "Instinct",
    category: "feature",
  },
  {
    title: "Query expansion is switched on",
    description:
      "When a question's words do not match the way documents are written, the product now asks again in other words. It was built and wired to accept a rewriter that nothing ever supplied. Turning it on raises retrieval on the labeled set. The looser trigger scores higher still and was not taken: measured against thirty real queries that had already found their answer, it would have rewritten twenty-six of them, at a model call and about two seconds each.",
    how_to_use:
      "Automatic. It only fires when the first attempt found nothing or the relevance judge rejected what it found.",
    area: "Instinct",
    category: "improvement",
  },
  {
    title: "Week one says something specific about a client's own library",
    description:
      "Phase One described the product. It now reads the client's library and asks about what it finds, as questions rather than conclusions. On our own it noticed that 413 of 982 documents shared a naming pattern and asked what they were: the answer, from a person, was our own scanning tool writing into the library. A report that had concluded instead would have been confidently wrong about the client's data on the first page it ever showed them.",
    how_to_use:
      "On the Phase One page. An answered question stops being asked, and the figures now count the client's library rather than ours plus theirs.",
    area: "Instinct",
    category: "feature",
  },
  {
    title: "An insight scan that says what it will not claim",
    description:
      "Reads a dataset and reports what can honestly be concluded from it, then what cannot and why. Run against 5,257 evaluation records it produces actions for a named team, each carrying the gap it closes, the records behind it, what would show it worked, and what would make it wrong. It refuses to read a trend when 79 per cent of records fall in one month, and refuses to describe a dimension recorded on 16 per cent of rows.",
    how_to_use:
      "Client Builds, then Results against plan. The plan it measured against is on the page, so any single line can be argued with rather than the whole page accepted or rejected.",
    area: "Instinct",
    category: "feature",
  },
  {
    title: "The pilot dashboard stopped reading the whole analytics table",
    description:
      "It read 2,639,165 rows to produce a figure that needs 6,385 of them, running an identity check on every one, because it filtered by date and left the event types to the aggregates. The page took twenty seconds to appear. Naming the types in the query changed no number and took the work from 1,445ms to 58ms, and the route as a whole from 1,858ms to 387ms.",
    how_to_use:
      "Nothing to do. A guardrail now fails any new query that bounds the analytics table by date without also bounding it by type.",
    area: "Instinct",
    category: "fix",
  },
  {
    title: "The retrieval eval grades the whole product, or refuses",
    description:
      "It already refused to run without an embedder. It did not check that the vector store answers, so a run with a rejected key graded the keyword half and reported the number as recall. Every retrieval figure produced that day was wrong in that direction. The labeled set also more than doubled, from 12 pairs to 28, and the score fell: the smaller number had been describing the set rather than the product.",
    how_to_use:
      "npm run eval:retrieval, or the Retrieval eval workflow. Pairs are generated from the documents themselves, so the correct answer is known by construction rather than inferred from what somebody clicked.",
    area: "Instinct",
    category: "improvement",
  },
  {
    title: "A public interest form for Weekend with Porsche",
    description:
      "Anybody interested can register without a login. The answers are kept and a lead is raised into an outbox that holds it: where it goes is a decision nobody has made yet, and nothing sends. Hardened with the defenses the ogiam contact form was attacked into learning, including deduplicating on the real mailbox rather than the typed string, which is how one person becomes three prospects a Center has to chase.",
    how_to_use:
      "The form is published per Center from a definition held in the repository, so the wording can be reviewed in a pull request rather than retyped.",
    area: "A Weekend with Porsche",
    category: "feature",
  },
  {
    title: "American spelling, and a check that keeps it",
    description:
      "The product wrote programme, centre, behaviour and thirty others to a client in North America. 587 files corrected, plus five filenames whose imports had already been rewritten. The sweep then over-reached and broke 85 files by turning realistic into realiztic and optimistic into optimiztic, which the guardrail held in place because the words it checked for were the ones it had created. Every rule is bound to a British ending now, and the test asserts the words a bare stem eats.",
    how_to_use:
      "Runs in the standard verification. Field names owned by outside systems are deliberately left alone.",
    area: "Instinct",
    category: "improvement",
  },
];

async function main(): Promise<void> {
  const release = await createRelease({
    version: "2026.09.01",
    title: "The day the product started proving its own claims",
    summary:
      "Eighteen changes, and one finding eighteen times: capabilities that were built, tested, configured, and had never once run. OCR on scanned documents, query expansion, the nightly document repair, the retrieval eval, the calendar calibration. None of them failed loudly, because a capability nothing exercises does not degrade. It simply never was, and the code reads identically either way. The library went from 884 readable documents to 982, and a register now asks daily whether each thing we claim has ever done its job on real data.",
    released_on: "2026-09-01",
    entries: ENTRIES,
    published: true,
    created_by: "release-notes",
  });
  console.log(`published ${release.version}: ${release.entries.length} entries`);
}

main().catch((err) => {
  const e = err as Error & { code?: string; detail?: string };
  console.error("failed:", e.message || "(no message)", e.code ?? "", e.detail ?? "");
  process.exit(1);
});
