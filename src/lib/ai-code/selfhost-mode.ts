/**
 * Graduated self-host enforcement - how the PR gate treats OUR OWN repos (the
 * tool guarding the tool), controlled by SELFHOST_GATE_MODE:
 *
 *   off      (default) - do not gate our own PRs at all. Merging this code changes
 *                        nothing until the mode is explicitly raised.
 *   comment            - run the gate and post what it WOULD decide as a NEUTRAL,
 *                        non-blocking check + comment. Watch it on live PRs first.
 *   enforce            - full blocking, exactly like a client repo.
 *
 * This applies ONLY to our own repos; client repos are always enforced and are
 * never affected by this flag. The staged rollout (off -> comment -> enforce) is
 * how we grant the tool authority over our own repo one reversible step at a time.
 */
export type SelfHostMode = "off" | "comment" | "enforce";

/** Our own repos, lowercased. A secret/gate decision on these is self-hosting. */
const OUR_REPOS = new Set(["the-wolfpack-agency/wolfpack-apex"]);

export function isOurRepo(repoFullName: string): boolean {
  return OUR_REPOS.has(repoFullName.toLowerCase());
}

/** The configured self-host mode. Anything but "comment"/"enforce" is "off", so a
 *  missing/typo'd env is fail-safe (does not act on our repo). */
export function selfHostMode(env: Record<string, string | undefined> = process.env): SelfHostMode {
  const m = (env.SELFHOST_GATE_MODE || "off").trim().toLowerCase();
  return m === "comment" || m === "enforce" ? m : "off";
}
