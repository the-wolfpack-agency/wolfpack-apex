/**
 * Platform-scan finding ingestion into the Central Brain.
 *
 * Mirrors src/lib/agents/audit/brain-ingest.ts: each finding becomes a concise,
 * human-readable summary in the Brain so the assistant can retrieve "what gaps
 * and bugs has the agent found on platform X" semantically. The findings table
 * is the source of truth; this is a derived, lossy view.
 *
 * Best effort + graceful by contract: a Brain failure must NEVER break a scan.
 */

import { ingest } from "@/lib/brain/ingest";
import type { ScanFinding } from "./types";

export const PLATFORM_SCAN_BRAIN_TAG = "platform-scan";

export async function ingestPlatformScanFinding(
  platform: string,
  finding: ScanFinding,
): Promise<void> {
  try {
    const summary =
      `Platform scan (${platform}) found a ${finding.severity} ${finding.category} on ${finding.route}: ` +
      `${finding.title}. ${finding.detail}`;
    await ingest({
      filename: `platform-scan-${platform}-${finding.route.replace(/\W+/g, "-")}.txt`,
      contentType: "text/plain",
      buffer: Buffer.from(summary, "utf8"),
      uploadedBy: "platform-scan",
      uploaderRole: "agent",
      tags: [
        PLATFORM_SCAN_BRAIN_TAG,
        `platform:${platform}`,
        `severity:${finding.severity}`,
        `category:${finding.category}`,
      ],
    });
  } catch (err) {
    console.warn("[platform-scan] brain ingest failed:", (err as Error)?.message ?? "unknown");
  }
}
