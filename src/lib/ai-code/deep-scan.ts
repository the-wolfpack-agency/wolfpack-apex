/**
 * Deep static scan of an authored change - the FULL platform-scan static engine
 * (provider-signature secrets, taint / SSRF / SQLi, and the rest of runDetectors),
 * not just the curated ai-code subset. This is "use the full power": the factory
 * runs the same deep detectors AgenticQA runs in CI, at author time.
 *
 * DRY: it does NOT reimplement detection. It reuses scanSource by injecting a
 * readFile that returns the AUTHORED file content, so no repo checkout or network
 * is needed. Scoped to NEW files today (the factory's current scope); editing
 * existing files is the workspace stage, where scanSource reads the real tree.
 */
import { scanSource } from "@/lib/platform-scan/static/scan";
import type { ScanFinding } from "@/lib/platform-scan/types";
import { newFilesFromDiff } from "./oracle";

export interface DeepScanSummary {
  scanned: number;
  findings: ScanFinding[];
  critical: number;
  high: number;
  /** A critical finding blocks the handoff, mirroring the code gate's critical -> block. */
  blocking: boolean;
}

export async function deepScanChange(diff: string, repoFullName = "the-wolfpack-agency/wolfpack-apex"): Promise<DeepScanSummary> {
  const files = newFilesFromDiff(diff);
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

  const critical = result.findings.filter((f) => f.severity === "critical").length;
  const high = result.findings.filter((f) => f.severity === "high").length;
  return { scanned: paths.length, findings: result.findings, critical, high, blocking: critical > 0 };
}
