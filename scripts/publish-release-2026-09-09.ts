/* FIRST. Imports hoist, so anything below already read process.env. */
import "./load-env";

/**
 * The 2026.09.09 release. Two threads over the week.
 *
 * Instinct kept closing the gap between what an answer claims and what it can
 * prove: the whole granted SharePoint estate now syncs (not one folder), every
 * synced document carries whose material it is, retrieval can scope to an
 * estate, and the assistant reads cleaner (concise answers, cited-source cards,
 * clickable readable document names, a stop to the mid-answer jump). Two gates
 * now stand in front of a client: an honest retrieval eval and a live
 * user-simulation E2E, plus an answer-hygiene harness that can replay a
 * thumbs-down back through the real router and gate.
 *
 * Ford (FDOS) went from a shell to a field-team platform: a change-management
 * program, ordering, dealer benchmarking, and an assistant that does not just
 * explain the tools but operates them. Entries are written for somebody who was
 * not here, from what merged, not from memory.
 */
import { createRelease, type ReleaseEntry } from "@/lib/releases";

const ENTRIES: ReleaseEntry[] = [
  {
    title: "The whole SharePoint estate syncs, and every document says whose it is",
    description:
      "Connecting SharePoint used to pull one folder; it now syncs the entire granted estate, and a single button on the admin page runs it. Every synced document is tagged with its source estate, and all nineteen sites are connected, so the library reflects what the client actually has rather than one corner of it.",
    how_to_use: "SharePoint admin page: 'Sync entire estate'. New documents carry their source automatically.",
    area: "Instinct", category: "feature",
  },
  {
    title: "The assistant reads cleaner and does not jump",
    description:
      "Answers are concise (which also cut the real model latency rather than masking it), cited sources render as cards even when they only appeared in the text footer, document links use the readable name instead of a bracketed raw filename, a staged thinking indicator shows progress, and a background refresh no longer makes the answer jump as you read it.",
    how_to_use: "Nothing to do; every answer benefits.",
    area: "Instinct", category: "improvement",
  },
  {
    title: "Two gates in front of a client, and a harness that replays complaints",
    description:
      "Before a client sees it, an honest retrieval eval and a live user-simulation E2E run against the real router and gate. An answer-hygiene harness runs prompts through that same path, and can now replay every thumbs-down answer from feedback to check the fix, so a complaint becomes a repeatable test.",
    how_to_use: "Runs in CI and on demand. A red gate blocks the release.",
    area: "Instinct", category: "feature",
  },
  {
    title: "A change-management program that does not lose the learning",
    description:
      "FDOS field reps run a program with dealers: write commitments, share them with a manager, the manager acknowledges, and check-ins are scheduled from the start date. A commitment is achieved only when the rep marks it done and the manager confirms it. Silence is visible, an active commitment goes overdue if its check-in is missed. Above the manager the cohort is counts and recurring themes, never individual plans, and reading one plan is an audited act. Because it is org-owned, the relationship history survives when a rep moves on.",
    how_to_use: "Change management in the menu. Admins set up programs; reps write and share a plan; managers acknowledge and confirm. A daily digest summarizes what needs attention.",
    area: "Ford", category: "feature",
  },
  {
    title: "Ordering, automated, so the visit is spent coaching",
    description:
      "FDOS drafts a recommended order from the dealer's live signals, open deals as demand, open recalls as parts to order, aging stock to hold back, ranked by priority. The rep reviews, approves, and tracks it through a real lifecycle. Automating the order hands the time back to coaching, which is where the top field reps spend theirs; the page opens into the three levers that separate top-performing dealerships, each with a concrete playbook.",
    how_to_use: "Ordering in the menu, or ask the assistant 'recommend an order for <dealer>'.",
    area: "Ford", category: "feature",
  },
  {
    title: "HQ dealer benchmarking with auto-generated reports",
    description:
      "Dealers are grouped into comparable cohorts (by area or by volume), scored and ranked on a health score, each with a peer-relative recommendation and a suggested target. A daily job stores a timestamped report snapshot per org, so HQ gets a report history without the manual spreadsheet work.",
    how_to_use: "Dealer benchmarking in the menu (admins). Reports regenerate daily; 'Generate now' produces one on demand.",
    area: "Ford", category: "feature",
  },
  {
    title: "The assistant operates the tools, not just explains them",
    description:
      "FDOS's assistant can view and run every field feature from chat: recommend and approve an order, benchmark the dealers, list programs, start and share a plan, acknowledge and confirm commitments. Reads answer instantly; anything that changes data shows exactly what it will do and waits for a one-click confirm, so nothing happens from a loose phrase. Flagship answers render as clean cards, and each tool page shows example prompts.",
    how_to_use: "Ask in plain words, or tap a prompt chip on any tool page. Ask 'what can I ask you to do?' for the full command set.",
    area: "Ford", category: "feature",
  },
  {
    title: "Role-aware onboarding and a page-aware assistant",
    description:
      "A new teammate lands after login into a tour that lists exactly the pages their role can reach and offers things to try. The assistant knows the product: it explains any page a user's role can access (and only those), and answers about FDOS itself.",
    how_to_use: "The tour shows on first login and reopens from the menu ('How to use FDOS').",
    area: "Ford", category: "feature",
  },
  {
    title: "The audit chain hashes canonically",
    description:
      "The tamper-evident audit log verified a hash over its metadata using key order, but metadata is stored as JSONB, which does not preserve order. The first log entry with a two-key metadata object reported the chain broken though nothing was altered. The hash is now canonical (keys sorted), so it is order-independent; all entries verify.",
    how_to_use: "Audit trail page shows the chain status.",
    area: "Ford", category: "fix",
  },
];

async function main() {
  const rel = await createRelease({
    version: "2026.09.09",
    title: "SharePoint whole-estate sync, client-ready gates, and the FDOS field-team platform",
    summary:
      "Instinct closes more of the gap between claim and proof: whole-estate SharePoint sync, source tagging across all nineteen sites, estate-scoped retrieval, a cleaner reading assistant, and two client-readiness gates with a complaint-replay harness. FDOS becomes a field-team platform: a change-management program, automated ordering, HQ benchmarking with auto-reports, and an assistant that operates the tools, not just explains them.",
    released_on: "2026-09-09",
    entries: ENTRIES,
    published: true,
    created_by: "release-notes",
  });
  console.log("published", rel.version, "with", ENTRIES.length, "entries");
}
main().catch((e) => { console.error("failed:", (e as Error).message); process.exit(1); });
