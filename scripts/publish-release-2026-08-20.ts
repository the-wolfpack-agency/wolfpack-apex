/**
 * Release report for 2026-08-20: the model router week.
 *
 * WHY A HAND-WRITTEN PUBLISHER, AGAIN
 *
 * Same reason as scripts/publish-release-2026-08-02.ts, which set this
 * precedent. The generator has an AI step that turns commit subjects into
 * plain-English breakdowns, and a documented fallback to commit-titles-only
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
 * Usage:  npx tsx scripts/publish-release-2026-08-20.ts [--dry-run]
 * Needs:  DATABASE_URL
 */
import { createRelease, type ReleaseEntry } from "@/lib/releases";

const DRY = process.argv.includes("--dry-run");
const AREA = "Instinct";

const entries: ReleaseEntry[] = [
  {
    title: "Where a request may be processed now travels with the request",
    description:
      "A gateway that offers data residency offers it as an account setting: pick a region once, in an admin screen, and everything inherits it. That answers where our traffic goes, which is not the question anybody is asked. The question in an audit is where a particular record went. So the requirement is now a property of the data. A marketing question goes to the cheapest model anywhere; the same workspace's employee records can require the EU and become unanswerable by a model in Virginia, in the same deployment, in the same minute, with nobody changing a setting. It fails closed on ignorance: a model whose region nobody has declared is refused for a request that requires one, because 'we did not know where it ran' is the answer that ends badly. The region that served is written into the tamper-evident record, taken from the same decision that allowed the call, and it is the one fact that cannot be reconstructed later: cost and tokens survive on a provider invoice, but nothing else says which region answered.",
    how_to_use:
      "Pass residency: ['eu'] on an AI request that carries data with a regional requirement. Declare where models run with AI_PROVIDER_REGION_AZURE, or AI_MODEL_REGION_<MODEL_ID> for one model. Admin, Model router lists every model with the region it runs in, and names the variable to set for any that have none.",
    area: AREA,
    category: "feature",
  },
  {
    title: "The two explanations on the router page fold away",
    description:
      "The page opened with two full explanations, so spend, activity and the model list all sat below them on a laptop. Both are now shut on arrival with their headline and one line of description still visible, and one click opens either. Folding lives in the shared panel component rather than on this page, so the next admin surface with the same problem gets it for free: it renders as a real disclosure element, which means it folds without JavaScript, is reachable by keyboard, and in-page find still reaches the text inside it.",
    how_to_use: "Open Admin, Model router. Click either heading at the top to read the explanation.",
    area: AREA,
    category: "improvement",
  },
  {
    title: "Every claim on the router page names the panel that proves it",
    description:
      "The explanation labelled each proof 'Where to point', which readers took as an instruction to point at something in the room rather than 'here is your evidence'. Each line now reads 'Proof on this page' and names the panel to scroll to. A test asserts every panel named actually exists, because a pointer to a panel that is not there is worse than no pointer: the reader looks, fails to find it, and stops believing the rest.",
    how_to_use: "Open Admin, Model router and expand 'What this does, in plain words'.",
    area: AREA,
    category: "improvement",
  },
  {
    title: "The router page's own test suite was never running, and had been wrong for weeks",
    description:
      "The spec that checks the model router page renders correct numbers was referenced by no workflow, so it had never run. Its header explains it stubs every response precisely so it needs no credentials and can run everywhere, and then it was never added to a job. Run by hand it failed 13 of 14. One cause was a service worker: the app registers one, a registered worker serves fetches itself, and those never reach the test's stubs, so the real interface answered mid-test and the session was torn down. It presented as flaky assertions about missing panels. The other five failures were assertions that an earlier release had made obsolete when it replaced the estimated cost with the amount actually billed, and nothing reported it. All fixed, and the spec is now a gate that must pass.",
    how_to_use: "",
    area: AREA,
    category: "fix",
  },
  {
    title: "A test that no job runs now fails the build",
    description:
      "The router spec rotted because nothing executed it, which made its red invisible. A new guard fails the build on any end-to-end spec that no workflow references. Seventy of the hundred specs in this repository are in that state today, so they are recorded as a named backlog that can only shrink: a new orphan fails on the pull request that creates it, while the existing seventy do not block unrelated work. A second guard fails if a name lingers on the backlog after its spec is finally wired in or deleted.",
    how_to_use: "",
    area: AREA,
    category: "improvement",
  },
];

async function main(): Promise<void> {
  const input = {
    version: "2026.08.20",
    title: "The model router grows a border",
    summary:
      "A week on the layer between the business and every AI model. Where a request may be processed is now a property of the data rather than an account setting, so one workspace can send a marketing question to the cheapest model on earth and refuse to let an employee record leave the EU, in the same minute, with nothing reconfigured. It fails closed on a model whose region nobody declared, and the region that served is written into the tamper-evident record, because that is the one fact no invoice can reconstruct afterwards. The page that reports all of this stops burying its numbers under two explanations, every claim on it now names the panel that proves it, and the test suite guarding those numbers, which turned out to have never run at all, both runs and tells the truth.",
    released_on: "2026-08-20",
    entries,
    published: true,
    created_by: "release-script",
  };

  if (DRY) {
    console.log(`[release] DRY RUN: ${entries.length} entries, would upsert ${input.version}`);
    for (const e of entries) console.log(`  - [${e.category}] ${e.title}`);
    return;
  }

  const rel = await createRelease(input);
  console.log(`[release] published ${rel.version} (${entries.length} entries): ${rel.title}`);
}

main().catch((err) => {
  console.error("[release] failed:", (err as Error).message);
  process.exit(1);
});
