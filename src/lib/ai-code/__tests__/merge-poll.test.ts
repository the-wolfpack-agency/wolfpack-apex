/** Merge-outcome poller: merged -> pr_merged, closed-unmerged -> pr_closed_unmerged,
 *  still-open -> nothing, already-reported -> deduped, unreadable -> skipped. */
import { classifyOutcomes, pollMergeOutcomes, type OpenedPr, type PrState } from "../merge-poll";

const opened: OpenedPr[] = [
  { repo: "o/a", prNumber: 1 },
  { repo: "o/b", prNumber: 2 },
  { repo: "o/c", prNumber: 3 },
  { repo: "o/d", prNumber: 4 },
];
const state = (repo: string): PrState | null => {
  if (repo === "o/a") return { merged: true, closedUnmerged: false };
  if (repo === "o/b") return { merged: false, closedUnmerged: true };
  if (repo === "o/c") return { merged: false, closedUnmerged: false }; // still open
  return null; // o/d unreadable
};

describe("classifyOutcomes", () => {
  it("emits merged / closed-unmerged, skips still-open + unreadable", () => {
    const out = classifyOutcomes(opened, (r) => state(r), new Set());
    expect(out).toEqual([
      { repo: "o/a", prNumber: 1, event: "ai_code.pr_merged" },
      { repo: "o/b", prNumber: 2, event: "ai_code.pr_closed_unmerged" },
    ]);
  });
  it("dedupes against already-reported (terminal once)", () => {
    const out = classifyOutcomes(opened, (r) => state(r), new Set(["o/a#1"]));
    expect(out.map((o) => o.repo)).toEqual(["o/b"]);
  });
});

describe("pollMergeOutcomes", () => {
  it("loads, fetches state, emits settled outcomes, never throws on a bad read", async () => {
    const emitted: string[] = [];
    const out = await pollMergeOutcomes({
      loadOpenedPrs: async () => opened,
      loadAlreadyReported: async () => new Set<string>(),
      prState: async (repo) => { if (repo === "o/d") throw new Error("boom"); return state(repo); },
      emit: async (event, repo) => { emitted.push(`${event}:${repo}`); },
    });
    expect(out).toHaveLength(2);
    expect(emitted.sort()).toEqual(["ai_code.pr_closed_unmerged:o/b", "ai_code.pr_merged:o/a"]);
  });
});
