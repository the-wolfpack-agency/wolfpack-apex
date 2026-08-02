/**
 * One-off publisher for the 2026-08-02 release report.
 *
 * WHY NOT `npm run release:notes`
 *
 * The generator has one AI step that turns commit subjects into plain-English
 * feature breakdowns, and a documented fallback to commit-titles-only when the
 * gateway is unavailable. Run from a machine without gateway credentials it
 * takes that fallback, and the result is a release report whose every entry has
 * an empty description — technically a release, practically a changelog nobody
 * can read.
 *
 * So the entries below are written by hand, and go through the SAME
 * createRelease() the generator uses. Reusing the write path matters more than
 * reusing the authoring step: the row shape, the upsert-on-version behaviour
 * and the analytics all stay identical to a generated release.
 *
 * Kept in the repo rather than run as a throwaway, following the precedent of
 * scripts/backfill-release-notes.ts, so the published content is reviewable in
 * git rather than existing only as a row someone has to trust.
 *
 * Usage:  npx tsx scripts/publish-release-2026-08-02.ts [--dry-run]
 * Needs:  DATABASE_URL
 */
import { createRelease, type ReleaseEntry } from "@/lib/releases";

const DRY = process.argv.includes("--dry-run");
const AREA = "Instinct";

const entries: ReleaseEntry[] = [
  {
    title: "A generated site is now measured against its prototype, not judged by eye",
    description:
      "Spec-diff loads a prototype and a built page at the same viewports, measures every text element in a real browser, and reports what differs and by how much. Viewport height is part of the comparison because a hero sized in vh matches at one window height and not another. Font parity is checked by glyph advance rather than by the declared family name, because two builds can claim the same font while shipping different cuts.",
    how_to_use:
      "Open a site project in Instinct and use the spec-diff surface, or POST /api/admin/spec-diff with a prototype URL and a target URL. Every run is stored, so drift on one page can be tracked over time.",
    area: AREA,
    category: "feature",
  },
  {
    title: "Builds are judged against acceptance criteria before anyone opens them",
    description:
      "A site project can carry acceptance criteria as a validated object: the prototype URL, routes that must answer 2xx, text that must appear, pixel tolerance and font parity. When a deploy succeeds the build is queued for checking, and a scheduled run judges it against those criteria on the deployed URL. A check that could not be performed is recorded as 'could not be checked' and never as a pass, so a browser that failed to start can never look like a clean build.",
    how_to_use:
      "Open a site project, go to the Acceptance tab, fill in the criteria and save. From then on every deploy is checked automatically and the verdict appears on that tab.",
    area: AREA,
    category: "feature",
  },
  {
    title: "A code-injection hole in the site generator is closed",
    description:
      "The scaffolder that turns a brief into a client site was building page source by pasting brief text straight into it. Because brief text comes from an AI wireframe extraction and from whatever an operator types, copy could close an element and inject a script, or open an expression and print a build-time environment variable onto a public page. Instinct's own preview escaped correctly, so the preview looked right and only the deployed site was affected. Fixed by never emitting supplied text as code, and rolled out to all eleven client repositories that had copied the old generator. Every existing page was checked first: none contained injected output.",
    how_to_use:
      "Nothing to do. New sites get the fixed generator automatically, and the eleven existing client repositories were updated by pull request.",
    area: AREA,
    category: "fix",
  },
  {
    title: "The site template can build every section type the studio offers",
    description:
      "The studio offered twelve section types while the template could build eight, so a site using video, testimonials, pricing or FAQ rendered correctly in the preview and then failed to deploy, with the reason visible only in a build log. The four missing types are now implemented, video embeds are sandboxed and restricted to known hosts, and FAQ answers are in the page for search engines rather than hidden behind script. A check now refuses a build the template cannot produce, naming the sections, instead of failing later.",
    how_to_use: "Use any section type in the studio. If one cannot be built you are told which, before the deploy starts.",
    area: AREA,
    category: "feature",
  },
  {
    title: "Agent containment: an allowlist, a budget, a stop, and a boundary that is proven rather than assumed",
    description:
      "Following the 2026 incidents where AI systems reached real infrastructure from environments believed to be isolated, agent work now runs against a named list of hosts per capability, a per-run ceiling on tokens, time, outbound calls and spend, and a stop that is checked before every step rather than at the start of a run. Before a batch starts, the boundary is exercised: hosts that must be refused are attempted, and if the refusal cannot be demonstrated the batch does not run. Every control fails closed, so an unreadable limit pauses the work instead of permitting it.",
    how_to_use: "Applies automatically to agent runs. The stop halts all agent work for the workspace immediately.",
    area: AREA,
    category: "feature",
  },
  {
    title: "Agents are scored on whether they stayed in bounds and told the truth",
    description:
      "The existing evaluation scored whether an agent succeeded. Two of the 2026 incidents were different failures: one system escaped its sandbox, another concealed a broken commitment for a week while appearing to perform well. Runs are now also scored on containment and honesty. Reaching a host outside the allowlist fails; being refused passes but is still reported; a boundary that was never demonstrated is recorded as unproven, which is not a pass. Honesty is measured by comparing what the executor recorded against what the agent reported, because an agent cannot grade its own transcript.",
    how_to_use: "Scores appear alongside existing model evaluations. A batch where the boundary was not demonstrated does not pass.",
    area: AREA,
    category: "feature",
  },
  {
    title: "Prompts are versioned artifacts with a stated scope",
    description:
      "System prompts were string constants scattered across a dozen files, which meant a change read as a string edit in review, a regression had no earlier version to compare against, and nothing could be scored because there was no stable identifier. Prompts now have an identifier, a version, typed inputs and an explicit scope, and the registry refuses to accept one that does not say what it may not touch. Two support prompts are migrated and a build check prevents new inline prompts from appearing.",
    how_to_use: "Nothing changes day to day. Prompt changes now appear in review as versioned content.",
    area: AREA,
    category: "improvement",
  },
  {
    title: "The studio can tell which element you selected, and what may be changed on it",
    description:
      "Clicking an element in the site preview now reports which section and part it belongs to, along with its rendered typography and spacing values, so the inspector can bind to it. Prompted style changes go through a gate that accepts a named token, a direction and a size of step: the model never writes CSS. Values outside the design scale, unknown properties and jumps larger than three steps are refused with a reason.",
    how_to_use: "Click an element in the site preview. The inspector follows the selection.",
    area: AREA,
    category: "feature",
  },
  {
    title: "Sign-in can no longer leave you holding a dead button",
    description:
      "A report of the sign-in button sticking on 'Signing in…' indefinitely, where only a private window worked. The page never re-enabled the button after a successful sign-in, so any navigation that failed to complete left a control that did nothing and showed nothing. Sign-in now performs a full page load so the new session cookies are sent on a fresh request, clears any previous client session first, and falls back after a few seconds with a message and a working button.",
    how_to_use: "Sign in normally. If the app does not open you are now told what to do instead of being left waiting.",
    area: AREA,
    category: "fix",
  },
  {
    title: "Development guardrails: branch hygiene, flake removal and a session retrospective",
    description:
      "Three internal controls. A branch check detects the states that squash-merging turns into conflicts and prints the exact commands out, including work stacked on an open pull request and stashes left parked where a later operation would collide with them. A backoff test that failed roughly one run in eleven hundred was traced to unpinned randomness and made deterministic. And the session handoff now asks what would have made the request work first time, so repeated friction becomes a pattern rather than a fresh discovery each time.",
    how_to_use: "Run npm run branch:check before pushing; it also runs as part of the standard verification.",
    area: AREA,
    category: "improvement",
  },
  {
    title: "Tools is hidden from the navigation",
    description:
      "The Tools entry no longer appears in the left navigation. The page still exists and remains reachable by direct link, and it stays in the navigation customizer so it can be brought back without a code change.",
    how_to_use: "Nothing to do. Use a direct link to /tools if you need it.",
    area: AREA,
    category: "improvement",
  },
];

async function main(): Promise<void> {
  const input = {
    version: "instinct-2026-08-02",
    title: "Wolfpack Instinct: Release Report 2026-08-02",
    summary:
      "Two weeks of work on making generated sites verifiable and agents contained. Sites are now measured against their prototypes and judged against written acceptance criteria before anyone looks at them; a code-injection hole in the site generator was found and closed across every client repository; and agent work runs inside an allowlist, a budget and a stop, with the boundary proven before each batch rather than assumed. Plus the sign-in fix, prompt versioning, and the development guardrails that came out of the incidents along the way.",
    released_on: "2026-08-02",
    entries,
    published: true,
    created_by: "release-script",
  };

  if (DRY) {
    console.log(`[release] DRY RUN — ${entries.length} entries, would upsert ${input.version}`);
    for (const e of entries) console.log(`  - [${e.category}] ${e.title}`);
    return;
  }

  const rel = await createRelease(input);
  console.log(`[release] published ${rel.version} (${entries.length} entries) — ${rel.title}`);
}

main().catch((err) => {
  console.error("[release] failed:", (err as Error).message);
  process.exit(1);
});
