/* FIRST. Imports hoist, so anything below already read process.env. */
import "./load-env";

/**
 * The 2026-09-17 release: a governed, model-agnostic way to let AI build and
 * act. Written from the pull requests that merged (#703-717), not from memory.
 *
 * Two products came together here. Secure Agent governs the CODE an AI writes,
 * before it can merge. Forcefield governs what a running agent DOES, and stops
 * it the instant it touches something it should not. The through-line is the
 * same one the platform has argued all along: the rules live in the machine the
 * AI works inside, enforced by tooling, not trusted to a model's memory. That
 * is why a claim like "checked by an independent model" or "any model, same
 * governance" is a thing an auditor can test here rather than a thing we assert.
 *
 * Entries are written for somebody who was not here.
 */

import { createRelease, type ReleaseEntry } from "@/lib/releases";

const ENTRIES: ReleaseEntry[] = [
  {
    title: "AI can now write code that has to pass a gate before it merges",
    description:
      "A model proposes a change and a deterministic gate, not another model, decides whether it may merge. It reads the changed lines for secrets, reset links, injection, weak crypto and disabled TLS, classifies each by known weakness type, and fails closed: a critical finding blocks, a high one goes to a person, and only a clean change is allowed. The decision is a rule that can be read in plain words afterwards, not a model's opinion.",
    how_to_use:
      "Code Gate in the admin area, or POST a diff to the review endpoint. The verdict, the findings, and the reason are recorded and hash-chained.",
    area: "OGIAM IAM",
    category: "feature",
  },
  {
    title: "A model of a different family checks the work",
    description:
      "On a deployment where one vendor serves everything, a model's output was being reviewed by a sibling, which correlates rather than checks and fails quietly by agreeing. The reviewer is now chosen by lineage: a Claude-authored change is confirmed by an OpenAI, Meta or DeepSeek model and never by another Claude. If no independent family is configured, the check records itself as unchecked rather than pretending, because a reassuring row that means nothing is worse than an honest gap.",
    how_to_use:
      "Automatic when a review runs with judging on. The author family and the judge family are recorded on each finding.",
    area: "OGIAM IAM",
    category: "feature",
  },
  {
    title: "A failed change repairs itself, and still cannot dodge the gate",
    description:
      "When the gate stops a change, the work re-routes to a different model to fix it, and the SAME gate re-checks every rewrite. A model can never talk its way past the rule that stopped it: an empty or hand-waved fix is rejected, retries are bounded and escalate a tier, and anything still failing goes to a human. Nothing is ever handed off as ready when the gate did not allow the final version.",
    how_to_use:
      "Runs inside the pipeline. A change ends either ready for a pull request or explicitly needing a person.",
    area: "OGIAM IAM",
    category: "feature",
  },
  {
    title: "The whole path runs as one governed pipeline",
    description:
      "Intake turns a request into a frozen, content-hashed spec through fixed multiple-choice questions rather than open-ended generation. The change is then gated, repaired if needed, and measured against the spec it committed to, so a change that is clean but quietly skipped its own promised tests or analytics is flagged as off-spec rather than waved through. On a pass it captures a pending approval; it never opens a pull request by itself.",
    how_to_use:
      "The pipeline endpoint runs the stages in order. An off-menu intake answer is refused as a bad request, not accepted and worked around.",
    area: "OGIAM IAM",
    category: "feature",
  },
  {
    title: "A trust view for everyone, not only engineers",
    description:
      "A plain-language page shows what every AI-authored change is checked for, how many were governed, and what the gate caught. It is written so a non-engineer can see the product doing its job, rather than reading a wall of findings.",
    how_to_use:
      "Code governance in the admin area. It reads the workspace's own review history.",
    area: "OGIAM IAM",
    category: "feature",
  },
  {
    title: "Bring your own model, and prove the governance still holds",
    description:
      "A client can plug in their own model keys, so their chosen provider runs inside the same rules. To keep 'any model, same governance' a fact rather than a slogan, an adversarial set of good and bad changes runs through every model in the registry (Anthropic, OpenAI, Meta and DeepSeek) and shows the merge decision is identical whoever authored the code, and that bad code is rejected every time. Add a model that has no independent-family reviewer and the check goes red.",
    how_to_use:
      "Keys are stored encrypted and shown back only as a masked hint. The matrix runs in the standard verification as a permanent regression guard.",
    area: "OGIAM IAM",
    category: "feature",
  },
  {
    title: "Forcefield: decoys that trip an alarm the instant they are touched",
    description:
      "Forcefield plants decoys a running agent might reach for, a fake credential, a decoy route, a honey-row, a honeypot tool, that nothing legitimate ever touches. Any interaction is therefore a high-confidence sign of trouble. The decoy's real value never leaves the store, so it cannot be recognized and avoided; only a masked hint is ever shown back.",
    how_to_use:
      "Forcefield in the admin area. Plant a decoy by type and say where it is seeded.",
    area: "OGIAM IAM",
    category: "feature",
  },
  {
    title: "A touched decoy contains the agent automatically",
    description:
      "When a decoy is touched, the agent's access is revoked through the same audited path an admin would use, and a tamper-evident record of the trip is written, both as independent best-effort steps so a failure of one never stops the other. Contain first, triage after. The record carries only what tripped and where it was seeded, never the decoy value, so the audit trail cannot itself leak the trap.",
    how_to_use:
      "No action. Containment happens with no human in the critical path. The trips appear in the triage view.",
    area: "OGIAM IAM",
    category: "feature",
  },
  {
    title: "The tools an agent relies on can be pinned against a silent change",
    description:
      "An agent's tools can scan clean and then quietly change, a description rewritten to smuggle in instructions, a new dangerous capability added. Forcefield can pin a known-good manifest and, on the next scan, flag any drift from it as a critical finding, so a supply-chain rug-pull is caught rather than obeyed. Reordering the same tools is not drift; changing any of them is.",
    how_to_use:
      "Pinning rides on the existing tool scanner. A drifted server is flagged critical in the scan results.",
    area: "OGIAM IAM",
    category: "improvement",
  },
  {
    title: "See every trip, and who was contained",
    description:
      "A triage view lists the decoy touches that tripped containment: which agent was revoked, when, and why. It reads the platform's own decision ledger for exactly those events, so it is the same record an auditor would see. No trips reads as the good state, plainly.",
    how_to_use:
      "Recent trips on the Forcefield page. An empty list is what you want to see.",
    area: "OGIAM IAM",
    category: "feature",
  },
];

async function main(): Promise<void> {
  const release = await createRelease({
    version: "2026.09.17",
    title: "A governed, model-agnostic way to let AI build and act",
    summary:
      "Two products came together. Secure Agent governs the code an AI writes before it can merge: a deterministic gate decides, a model of a different family reviews, a failed change repairs itself without ever dodging the gate, and a person approves what ships. Forcefield governs what a running agent does: decoys that nothing legitimate touches trip containment the instant they are reached, revoking the agent and recording the event, and the tools an agent uses can be pinned so a silent change is caught. The rules live in the machine the AI works inside, enforced by tooling rather than trusted to a model, which is why 'checked by an independent model' and 'any model, same governance' are things you can test here rather than claims.",
    released_on: "2026-09-17",
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
