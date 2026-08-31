/**
 * A sync that reports success forever and never finishes.
 *
 * ingest() dedupes on the content hash and returns the existing row. Resume
 * skips files via findIngestedDriveItemIds, which keys on ms_drive_item_id. A
 * file whose bytes were already in the Brain from an earlier upload therefore
 * came back a SUCCESS, gained no drive item id, stayed invisible to the skip,
 * and was downloaded again on the next pass. And the next.
 *
 * Measured on TEST/General, 2,518 files:
 *
 *   pass 1   272 successes   2,143 remaining
 *   pass 2   262 successes   2,153 remaining
 *
 * The remaining count went UP. 534 reported successes had produced 56
 * documents carrying a drive item id, because the other 478 were duplicates
 * that could never be marked done. Auto-continue would have looped until it
 * hit its cap, reporting progress the whole way.
 *
 * Every individual piece behaved as written. Dedupe deduped, resume resumed,
 * the counters counted. The defect only exists where two correct behaviors
 * meet, which is why the convergence test below matters more than any
 * assertion about either half on its own.
 */

const mockQuery = jest.fn();
const mockTrack = jest.fn();

jest.mock("@/lib/db", () => ({ query: (...a: unknown[]) => mockQuery(...a), safeQuery: jest.fn() }));
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: unknown[]) => mockTrack(...a) }));

import { attachDriveItem } from "@/lib/brain/repo";

beforeEach(() => {
  jest.clearAllMocks();
  mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });
});

describe("claiming the drive item on a duplicate", () => {
  it("fills the id so the next pass can skip the file", () => {
    /* THE FIX IN ONE ASSERTION. Without the write, the skip list never grows
       and the folder never converges. */
    return attachDriveItem("doc-1", "drive-item-9", "https://x/f").then(() => {
      const [sql, params] = mockQuery.mock.calls[0];
      expect(String(sql)).toMatch(/UPDATE brain_documents/i);
      expect(String(sql)).toMatch(/ms_drive_item_id\s*=\s*\$2/);
      expect(params).toEqual(["doc-1", "drive-item-9", "https://x/f"]);
    });
  });

  it("only fills a NULL, so content in two folders keeps its first home", async () => {
    /* Rebinding on every sync would make the same document flip between
       folders on alternate runs, and its citations flip with it. */
    await attachDriveItem("doc-1", "drive-item-9");
    expect(String(mockQuery.mock.calls[0][0])).toMatch(/ms_drive_item_id IS NULL/);
  });

  it("does not overwrite an existing web_url", async () => {
    await attachDriveItem("doc-1", "drive-item-9", "https://new");
    expect(String(mockQuery.mock.calls[0][0])).toMatch(/web_url = COALESCE\(web_url, \$3\)/);
  });

  it("reports whether it actually claimed anything", async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    expect(await attachDriveItem("doc-1", "drive-item-9")).toBe(false);
    mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });
    expect(await attachDriveItem("doc-1", "drive-item-9")).toBe(true);
  });
});

/**
 * The property that was actually violated, stated directly.
 *
 * Neither half was wrong on its own, so no test of either half could have
 * caught this. What was untrue is that repeating a sync makes progress.
 */
describe("a repeated sync converges", () => {
  /** A Brain that dedupes by content and skips by drive item, as production does. */
  function fakeBrain(preexistingShas: string[]) {
    const bySha = new Map(preexistingShas.map((sha) => [sha, { id: `doc-${sha}`, driveItemId: null as string | null }]));
    return {
      /** Files a pass may skip: those bound to a drive item. */
      ingested(): Set<string> {
        return new Set([...bySha.values()].map((d) => d.driveItemId).filter(Boolean) as string[]);
      },
      /** One pass over a folder. Returns how many files it had to process. */
      pass(files: Array<{ driveItemId: string; sha: string }>, claimOnDuplicate: boolean): number {
        const skip = this.ingested();
        let processed = 0;
        for (const f of files) {
          if (skip.has(f.driveItemId)) continue;
          processed += 1;
          const existing = bySha.get(f.sha);
          if (existing) {
            if (claimOnDuplicate && existing.driveItemId === null) existing.driveItemId = f.driveItemId;
            continue;
          }
          bySha.set(f.sha, { id: `doc-${f.sha}`, driveItemId: f.driveItemId });
        }
        return processed;
      },
    };
  }

  const folder = Array.from({ length: 20 }, (_, i) => ({ driveItemId: `item-${i}`, sha: `sha-${i}` }));
  /* Every file's bytes are already in the Brain from an earlier upload, which
     is the situation on TEST/General. */
  const preexisting = folder.map((f) => f.sha);

  it("stops re-processing files once they are claimed", () => {
    const brain = fakeBrain(preexisting);
    expect(brain.pass(folder, true)).toBe(20);
    /* The whole point: the second pass has nothing left to do. */
    expect(brain.pass(folder, true)).toBe(0);
  });

  it("re-processes the same files forever when duplicates are not claimed", () => {
    /* The bug, reproduced. Three passes, identical work every time, and the
       operator watching sees "success" on each one. */
    const brain = fakeBrain(preexisting);
    expect(brain.pass(folder, false)).toBe(20);
    expect(brain.pass(folder, false)).toBe(20);
    expect(brain.pass(folder, false)).toBe(20);
  });

  it("still converges when nothing was there before", () => {
    /* The ordinary case must not regress: a fresh folder finishes in one pass
       whether or not the claim is needed. */
    const brain = fakeBrain([]);
    expect(brain.pass(folder, true)).toBe(20);
    expect(brain.pass(folder, true)).toBe(0);
  });
});
