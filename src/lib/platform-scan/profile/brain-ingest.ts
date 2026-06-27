/**
 * Ingest a SystemProfile into the Central Brain so the assistant can answer
 * "what does platform X consist of, what does it integrate with, where is the
 * risk" semantically. Mirrors ingestPlatformScanFinding: a concise human-readable
 * summary; the profiles table is the source of truth, this is a derived view.
 * Best effort: a Brain failure must NEVER break a profile build.
 */
import { ingest } from "@/lib/brain/ingest";
import type { SystemProfile } from "./types";

export const SYSTEM_PROFILE_BRAIN_TAG = "system-profile";

export async function ingestSystemProfile(profile: SystemProfile): Promise<void> {
  try {
    const integrations = profile.integrations.map((i) => `${i.name} (${i.category})`).join(", ") || "none detected";
    const summary =
      `System profile for ${profile.platform}. ` +
      `Surface: ${profile.surface.pages} pages, ${profile.surface.apiRoutes} API routes, ` +
      `${profile.surface.libModules} lib modules, ${profile.surface.migrations} migrations, ` +
      `${profile.surface.tests} test files. ` +
      `Data model (${profile.entities.length} tables): ${profile.entities.slice(0, 40).join(", ") || "none found"}. ` +
      `Integrations: ${integrations}. ` +
      `Auth: ${profile.authModel.protectedRoutes} protected / ${profile.authModel.publicRoutes} public routes. ` +
      `Risk: ${profile.riskSummary.critical} critical, ${profile.riskSummary.high} high, ` +
      `${profile.riskSummary.medium} medium, ${profile.riskSummary.low} low open findings.`;
    await ingest({
      filename: `system-profile-${profile.platform}.txt`,
      contentType: "text/plain",
      buffer: Buffer.from(summary, "utf8"),
      uploadedBy: "system-profiler",
      uploaderRole: "agent",
      tags: [
        SYSTEM_PROFILE_BRAIN_TAG,
        `platform:${profile.platform}`,
        ...profile.integrations.map((i) => `integration:${i.name}`),
      ],
    });
  } catch (err) {
    console.warn("[system-profile] brain ingest failed:", (err as Error)?.message ?? "unknown");
  }
}
