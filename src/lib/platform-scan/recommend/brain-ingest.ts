/**
 * Ingest an automation recommendation into the Central Brain so the assistant can
 * recall "what should we automate / fix on platform X" semantically. Mirrors the
 * other platform-scan ingesters: a concise summary; the recommendations table is
 * the source of truth. Best effort: never breaks recommendation generation.
 */
import { ingest } from "@/lib/brain/ingest";
import type { AutomationRecommendation } from "./types";

export const RECOMMENDATION_BRAIN_TAG = "automation-recommendation";

export async function ingestRecommendation(platform: string, rec: AutomationRecommendation): Promise<void> {
  try {
    const summary =
      `Automation recommendation for ${platform} (${rec.priority} ${rec.category}): ${rec.title}. ` +
      `Why: ${rec.rationale} Action: ${rec.suggestedAction}`;
    await ingest({
      filename: `recommendation-${platform}-${rec.key.replace(/\W+/g, "-")}.txt`,
      contentType: "text/plain",
      buffer: Buffer.from(summary, "utf8"),
      uploadedBy: "automation-recommender",
      uploaderRole: "agent",
      tags: [
        RECOMMENDATION_BRAIN_TAG,
        `platform:${platform}`,
        `priority:${rec.priority}`,
        `category:${rec.category}`,
      ],
    });
  } catch (err) {
    console.warn("[recommend] brain ingest failed:", (err as Error)?.message ?? "unknown");
  }
}
