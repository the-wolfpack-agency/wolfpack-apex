/**
 * Deep static scan of an authored change - the FULL platform-scan static engine
 * (provider-signature secrets, taint / SSRF / SQLi, and the rest of runDetectors),
 * not just the curated ai-code subset. This is "use the full power": the factory
 * runs the same deep detectors AgenticQA runs in CI, at author time.
 *
 * DRY: it does NOT reimplement detection. It reuses scanSource by injecting a
 * readFile that returns the AUTHORED file content, so no repo checkout or network
 * is needed. It scans the FULL content of every changed file - new AND edited -
 * when the caller passes `changedFiles` (files/anchor mode carry full contents),
 * so a secret or SSRF introduced via an edit to an existing file is caught, not
 * only brand-new files. For a pure unified-diff run it falls back to the new
 * files reconstructed from the diff.
 */
import { scanSource } from "@/lib/platform-scan/static/scan";
import type { ScanFinding } from "@/lib/platform-scan/types";
import { newFilesFromDiff } from "./oracle";
import { scanDestructiveSql } from "./destructive-sql";

export interface DeepScanSummary {
  scanned: number;
  findings: ScanFinding[];
  critical: number;
  high: number;
  /** A critical finding blocks the handoff, mirroring the code gate's critical -> block. */
  blocking: boolean;
}

export async function deepScanChange(
  diff: string,
  repoFullName = "the-wolfpack-agency/wolfpack-apex",
  changedFiles?: readonly { path: string; content: string }[],
): Promise<DeepScanSummary> {
  // Prefer the full changed-file contents (new AND edited) when the caller has
  // them; fall back to new-files-from-diff for a pure-diff run. This is what
  // makes an EDIT to an existing file deep-scanned, not just new files.
  const files: Record<string, string> =
    changedFiles && changedFiles.length > 0
      ? Object.fromEntries(changedFiles.map((c) => [c.path, c.content]))
      : newFilesFromDiff(diff);
  const paths = Object.keys(files);
  if (paths.length === 0) return { scanned: 0, findings: [], critical: 0, high: 0, blocking: false };

  const [owner, repo] = repoFullName.includes("/") ? repoFullName.split("/", 2) : ["local", repoFullName];
  const result = await scanSource({
    platform: "instinct-factory",
    owner,
    repo,
    paths,
    // Inject the authored content: the "repo" is the diff itself, no checkout.
    readFile: async (p) => (p in files ? files[p] : null),
  });

  // Merge destructive-migration findings (DROP TABLE/TRUNCATE/DROP COLUMN) - valid
  // SQL the deep detectors do not flag, but a data-loss op the gate must HOLD.
  const findings = [...result.findings, ...scanDestructiveSql(files)];
  const critical = findings.filter((f) => f.severity === "critical").length;
  const high = findings.filter((f) => f.severity === "high").length;
  return { scanned: paths.length, findings, critical, high, blocking: critical > 0 };
}
