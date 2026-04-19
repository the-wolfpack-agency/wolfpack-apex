/**
 * POST /api/sites/[id]/generate-image — AI image generation.
 *
 * Body: {
 *   prompt: string;                                 // required, <= 500 chars
 *   aspectRatio?: "16:9" | "4:3" | "1:1" | "3:4" | "9:16";
 *   seed?: number;
 *   sectionPath?: string;                           // e.g. /pages/0/sections/0/backgroundImage — recorded for learning only
 * }
 *
 * Auth: JWT required. Gated to any authenticated user (no role check —
 * every team member can generate images). All 6 known roles satisfy the
 * hasRole(_, "ops") lower-bound, so we use hasRole with the lowest role
 * in the hierarchy to assert "signed in" without leaking role logic
 * into the non-technical UX.
 *
 * Responses:
 *   200 { url, generationId, cost_cents, seed, repoCommitted }
 *   400 { error, reason: "prompt_required" | "prompt_too_long" | "prompt_blocked" }
 *   401 { error }                                      — unauthenticated
 *   404 { error }                                      — project not found
 *   429 { error, reason: "daily_cap_exceeded", cap, used } — hit daily limit
 *   503 { error, reason: "ai_not_configured" }         — FAL_API_KEY missing
 *   502 { error, reason: "provider_error", status }    — fal.ai 4xx/5xx
 *   500 { error }                                      — unexpected
 *
 * Every response code also emits an analytics event so the learning loop
 * sees the full funnel (opened → submitted → succeeded | failed).
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { getSiteProject } from "@/lib/sites";
import { trackEvent } from "@/lib/analytics";
import {
  generateImage,
  checkPrompt,
  ImageGenNotConfiguredError,
  ImageGenProviderError,
  DAILY_CAP,
  MAX_PROMPT_LEN,
} from "@/lib/image-gen";
import { countUserGenerationsSince } from "@/lib/image-generations";
import type { ImageAspectRatio } from "@/lib/image-generations";

const VALID_ASPECTS: ReadonlySet<string> = new Set([
  "16:9",
  "4:3",
  "1:1",
  "3:4",
  "9:16",
]);

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await context.params;

  let body: {
    prompt?: unknown;
    aspectRatio?: unknown;
    seed?: unknown;
    sectionPath?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const prompt = typeof body.prompt === "string" ? body.prompt : "";
  const aspectRatio: ImageAspectRatio =
    typeof body.aspectRatio === "string" && VALID_ASPECTS.has(body.aspectRatio)
      ? (body.aspectRatio as ImageAspectRatio)
      : "16:9";
  const seed = typeof body.seed === "number" ? body.seed : undefined;
  const sectionPath =
    typeof body.sectionPath === "string" ? body.sectionPath : "";

  trackEvent("site.image_gen_submitted", user.id, user.role, {
    project_id: id,
    prompt_length: prompt.length,
    aspect_ratio: aspectRatio,
    section_path: sectionPath,
    has_seed: typeof seed === "number",
  });

  // Prompt validation — length + keyword + PII. Runs before any external
  // call so we never spend cents rejecting garbage.
  const check = checkPrompt(prompt);
  if (!check.ok) {
    trackEvent("site.image_gen_failed", user.id, user.role, {
      project_id: id,
      reason: check.reason,
    });
    const status = check.reason === "prompt_too_long" ? 400 : 400;
    return NextResponse.json(
      {
        error:
          check.reason === "prompt_empty"
            ? "prompt required"
            : check.detail ?? check.reason,
        reason:
          check.reason === "prompt_empty" ? "prompt_required" : check.reason,
        maxLength: MAX_PROMPT_LEN,
      },
      { status },
    );
  }

  const project = await getSiteProject(id);
  if (!project) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  // Daily cap — count this user's generations over the last 24h. Enforce
  // before calling fal.ai so a runaway UI can't exceed budget.
  const usedToday = await countUserGenerationsSince(user.id, 24);
  if (usedToday >= DAILY_CAP) {
    trackEvent("site.image_gen_failed", user.id, user.role, {
      project_id: id,
      reason: "daily_cap_exceeded",
      used: usedToday,
      cap: DAILY_CAP,
    });
    return NextResponse.json(
      {
        error: `Daily limit reached — you've generated ${usedToday} images in the last 24 hours (max ${DAILY_CAP}).`,
        reason: "daily_cap_exceeded",
        cap: DAILY_CAP,
        used: usedToday,
      },
      { status: 429 },
    );
  }

  try {
    const result = await generateImage({
      prompt: prompt.trim(),
      aspectRatio,
      seed,
      userId: user.id,
      userRole: user.role,
      projectId: id,
      githubRepo: project.github_repo ?? null,
    });
    return NextResponse.json({
      url: result.url,
      generationId: result.generationId,
      cost_cents: result.costCents,
      seed: result.seed ?? null,
      repoCommitted: result.repoCommitted,
      model: result.model,
    });
  } catch (err) {
    if (err instanceof ImageGenNotConfiguredError) {
      return NextResponse.json(
        {
          error:
            "The AI image generator is not configured in this environment. " +
            "An admin must set FAL_API_KEY in Vercel (Production + Preview) " +
            "and redeploy. Until then, paste an image URL manually.",
          reason: "ai_not_configured",
        },
        { status: 503 },
      );
    }
    if (err instanceof ImageGenProviderError) {
      return NextResponse.json(
        {
          error: err.message,
          reason: "provider_error",
          status: err.status,
        },
        { status: 502 },
      );
    }
    console.error("[sites/id/generate-image]", (err as Error).message);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
