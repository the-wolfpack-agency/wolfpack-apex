/**
 * The one line on a release that carries a number.
 *
 * Worth its own test because the numbers are the part a reader trusts without
 * checking: a release that says "1 files changed" or that silently drops the
 * thousands separator reads as sloppy about the figure itself.
 */
import { formatDiffStat } from "../releases";

describe("formatDiffStat", () => {
  it("reads as a sentence for a real release", () => {
    expect(
      formatDiffStat({ commits: 112, files: 198, insertions: 17774, deletions: 664 }),
    ).toBe("112 commits, 198 files changed, 17,774 lines added and 664 removed.");
  });

  it("groups thousands, because seven digits unseparated is unreadable", () => {
    expect(formatDiffStat({ commits: 2, files: 3, insertions: 1855340, deletions: 0 })).toContain(
      "1,855,340 lines added",
    );
  });

  it("says commit, file and line in the singular when there is one of them", () => {
    expect(formatDiffStat({ commits: 1, files: 1, insertions: 1, deletions: 1 })).toBe(
      "1 commit, 1 file changed, 1 line added and 1 removed.",
    );
  });

  /* A range git could not stat (no tags, a bad ref, a repo that would not
     read) comes back with zero files. Reporting "0 files changed, 0 lines
     added" states a measurement that was never taken; the commit count is
     the part that is still true. */
  it("falls back to the commit count alone when nothing could be measured", () => {
    expect(formatDiffStat({ commits: 9, files: 0, insertions: 0, deletions: 0 })).toBe("9 commits.");
    expect(formatDiffStat({ commits: 1, files: 0, insertions: 0, deletions: 0 })).toBe("1 commit.");
  });

  it("handles a deletion-only release", () => {
    expect(formatDiffStat({ commits: 4, files: 12, insertions: 0, deletions: 3200 })).toBe(
      "4 commits, 12 files changed, 0 lines added and 3,200 removed.",
    );
  });
});
