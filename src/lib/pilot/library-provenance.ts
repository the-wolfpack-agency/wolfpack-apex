/**
 * Which documents are the library, and which are our own tools writing into it.
 *
 * WHAT THIS IS THE ANSWER TO. The week-one questions noticed that 413 of 982
 * indexed documents shared a naming pattern and asked whether they were
 * re-exports, tool output, or genuinely separate documents. The answer came
 * back from a person: it is our own platform-scan tool, run against client
 * systems. That is the process working, and the playbook says what happens
 * next: what comes back becomes configuration, not code.
 *
 * WHY IT MATTERS TO A CLIENT-FACING FIGURE. "982 documents indexed" is 544
 * documents plus 438 scanner artifacts. Quoting the larger number to a client
 * describes a library 80 per cent bigger than the one that can answer their
 * questions, and the difference is entirely our own tooling. A figure that
 * flatters us by counting our own output is the kind that gets checked once
 * and never trusted again.
 *
 * IT EXCLUDES FROM THE COUNT, NOT FROM THE INDEX. The scans stay searchable:
 * they are useful to whoever ran them, and removing them would be answering a
 * different question than the one that was asked. What changes is that a
 * headline about the client's library counts the client's library.
 */

/**
 * Documents produced by our own tooling rather than supplied by anyone.
 *
 * Matched on the prefix the tool writes, which is stable because the tool
 * chooses it. A tag would be better and needs a migration plus a backfill of
 * 438 rows; this is the same answer today and can become a tag when something
 * else needs one.
 */
const OUR_TOOLING = /^platform-scan-/i;

export function isOurOwnTooling(filename: string): boolean {
  return OUR_TOOLING.test(filename);
}

export interface LibraryCount {
  /** Documents somebody put there, which is what a client means by their library. */
  supplied: number;
  /** Documents our tools wrote. Reported, never hidden. */
  ourTooling: number;
}

export function countLibrary(filenames: readonly string[]): LibraryCount {
  let ourTooling = 0;
  for (const f of filenames) if (isOurOwnTooling(f)) ourTooling += 1;
  return { supplied: filenames.length - ourTooling, ourTooling };
}
