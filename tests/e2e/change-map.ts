/**
 * Which e2e spec covers which source files.
 *
 * WHY THIS EXISTS. On 2026-08-26 a readiness panel was added to /playbook and
 * pushed with `scripts/verify.sh` reporting nine green stages. The stage that
 * would have caught it printed `[SKIP] e2e-smoke (local run - CI only)`, so the
 * page's own e2e spec never ran, and the regression was found by a hard gate
 * after it had already reached production and turned every open PR red.
 *
 * Running the WHOLE e2e suite in verify would have caught it and would also
 * have made verify slow enough that people stop running it, which is a worse
 * outcome by a wide margin. So this maps source paths to the specs that cover
 * them: touch /playbook and the playbook spec runs, touch nothing that is
 * mapped and the stage costs one `git diff`.
 *
 * ONLY SPECS THAT NEED NO CREDENTIALS belong here. A spec that skips for want
 * of a secret reports as a pass, which is the same invisible-skip problem in a
 * new place. Every entry below stubs its own network or reads a public page.
 *
 * MEANT TO GROW. A page with an e2e spec and no entry here is a page whose
 * spec only runs post-merge.
 */

export interface ChangeMapEntry {
  /** Substrings matched against changed paths, from `git diff --name-only`. */
  paths: string[];
  /** The spec to run when any path matches. */
  spec: string;
  /** Why this spec covers those paths. */
  why: string;
}

export const CHANGE_MAP: ChangeMapEntry[] = [
  {
    paths: [
      "src/app/(dashboard)/playbook/",
      "src/lib/playbook.ts",
      "src/lib/playbook/",
      "src/lib/markdown",
    ],
    spec: "tests/e2e/playbook-readable.spec.ts",
    why: "the client-facing document; it shipped correct and unreadable twice, and a third time as a selector collision",
  },
  {
    paths: ["src/app/(dashboard)/admin/ai-router/", "src/lib/ai/models/"],
    spec: "tests/e2e/ai-router-behavior.spec.ts",
    why: "the cost page; it reported $0.00 for real spend and 0% from the cheap tier",
  },
  {
    paths: [
      "src/components/ChatWidget.tsx",
      "src/components/widgets/PilotStatusWidget.tsx",
      "src/lib/assistant/widgets/types.ts",
    ],
    spec: "tests/e2e/assistant-pilot-status.spec.ts",
    why: "the widget dispatcher; a kind missing from its switch renders nothing and fails silently, which hid TimeLogWidget for two months",
  },
  {
    paths: ["src/components/widgets/CrossToolInsightsWidget.tsx"],
    spec: "tests/e2e/assistant-cross-tool-insights.spec.ts",
    why: "same dispatcher risk, and it proves the composer submit path still works",
  },
];

/**
 * The specs to run for a set of changed files.
 *
 * A stylesheet is deliberately NOT mapped to everything. globals.css touches
 * every page, so mapping it would run the whole suite on any style change and
 * turn this into the slow thing it exists to avoid. The playbook entry above
 * covers the case that actually bit us, because that regression was markup.
 */
export function specsForChanges(changed: string[]): string[] {
  const out = new Set<string>();
  for (const entry of CHANGE_MAP) {
    if (changed.some((f) => entry.paths.some((p) => f.includes(p)))) {
      out.add(entry.spec);
    }
  }
  return [...out].sort();
}
