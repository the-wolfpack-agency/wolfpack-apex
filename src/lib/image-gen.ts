/**
 * image-gen — wraps fal.ai FLUX.1 [schnell] for the Sites tool.
 *
 * Why fal.ai: cheapest per-image on the market at ~$0.003 with clear
 * commercial licensing, simple REST (no SDK), < 5s typical latency.
 *
 * Why schnell: the non-technical team iterates visually and wants fast
 * previews, not photoreal perfection. Schnell ("fast") is tuned for
 * turn-around, not detail — exactly the UX of "generate, tweak prompt,
 * try another". For higher-quality hero shots the user still has the
 * [dev] and [pro] variants behind the same API if we ever expose them.
 *
 * Flow:
 *   1. Preflight: FAL_API_KEY must be set — otherwise throw typed
 *      ImageGenNotConfiguredError. Route surfaces a 503 with the env var
 *      name (same pattern as ANTHROPIC_API_KEY in brief-edit).
 *   2. POST to fal.ai → receive a CDN URL.
 *   3. Fetch the image bytes, commit to the project's github repo at
 *      public/generated/{generationId}.jpg via putFile, so the deployed
 *      site owns its own copy and doesn't break if fal's CDN expires.
 *   4. Persist a row in instinct_site_image_generations (even on fal errors
 *      — data never lost).
 *   5. Return the raw.githubusercontent.com URL that points at the
 *      freshly-committed file.
 *
 * If the project row doesn't have a github_repo (draft site, hasn't
 * been provisioned yet), we skip the commit step and return the fal.ai
 * CDN URL instead, flagged with repo_committed=false in the audit row.
 * That's a deliberate fallback so the generator works during the first
 * onboarding pass when the repo hasn't been created.
 *
 * Zero-tokens rule: the fal.ai call is the only external cost. Every
 * other step (env check, persistence, repo commit, event emission) is
 * local / already-paid-for infra.
 */

import { randomUUID } from "node:crypto";
import { trackEvent } from "@/lib/analytics";
import {
  putFile,
  defaultGithubClient,
  type GithubClient,
} from "@/lib/github-client";
import {
  insertImageGeneration,
  type ImageAspectRatio,
} from "@/lib/image-generations";

/* ------------------------------ Types --------------------------------- */

export interface GenerateImageInput {
  prompt: string;
  aspectRatio?: ImageAspectRatio;
  seed?: number;
  userId: string;
  userRole: string;
  projectId: string;
  // Repo full_name (owner/repo) — the route resolves this from the
  // SiteProject row and passes it in so image-gen stays pure about which
  // repo to commit into. When null we skip the commit and return the
  // fal.ai CDN URL.
  githubRepo: string | null;
  // Injectables for testing.
  fetchImpl?: typeof fetch;
  githubClient?: GithubClient;
}

export interface GenerateImageResult {
  generationId: string;
  url: string;
  repoCommitted: boolean;
  latencyMs: number;
  model: string;
  seed: number | undefined;
  costCents: number | null;
}

/* ------------------------------ Errors -------------------------------- */

/**
 * FAL_API_KEY missing — config problem, not a transient one. The route
 * surfaces a 503 with the env var name + actionable "ask an admin"
 * message, matching the ANTHROPIC_API_KEY pattern.
 */
export class ImageGenNotConfiguredError extends Error {
  constructor(
    message = "FAL_API_KEY is not set — AI image generator disabled",
  ) {
    super(message);
    this.name = "ImageGenNotConfiguredError";
  }
}

/**
 * fal.ai returned a non-2xx response. `status` + `body` are surfaced so
 * the route can pass the actionable error through to the user instead
 * of the generic "something went wrong".
 */
export class ImageGenProviderError extends Error {
  constructor(
    message: string,
    public status: number,
    public body: string,
  ) {
    super(message);
    this.name = "ImageGenProviderError";
  }
}

/* ------------------------- Constants --------------------------------- */

// FLUX.1 [schnell] on fal.ai — fast + cheapest. Update this string when
// you swap models; the value flows into instinct_site_image_generations.model
// so the learning loop can segment performance by model.
export const IMAGE_GEN_MODEL = "fal-ai/flux/schnell";

// fal.ai's public per-megapixel price for schnell (2026-04): ~$0.003.
// Captured in cents (rounded up to 1 cent — sub-cent accounting is noise
// at our scale) so `cost_cents INTEGER` column works cleanly.
const COST_CENTS_PER_IMAGE = 1;

const FAL_ENDPOINT = "https://fal.run/fal-ai/flux/schnell";

// fal.ai's "image_size" parameter accepts a string or a { width, height }
// pair. We stick to the named presets so the request stays compact and
// matches the 5 aspect-ratio tiles in the UI picker.
const ASPECT_RATIO_TO_IMAGE_SIZE: Record<ImageAspectRatio, string> = {
  "16:9": "landscape_16_9",
  "4:3": "landscape_4_3",
  "1:1": "square_hd",
  "3:4": "portrait_4_3",
  "9:16": "portrait_16_9",
};

/* --------------------------- fal.ai request -------------------------- */

interface FalSuccessResponse {
  images: Array<{ url: string; width?: number; height?: number }>;
  seed?: number;
  timings?: Record<string, number>;
  has_nsfw_concepts?: boolean[];
}

async function callFalAi(args: {
  prompt: string;
  aspectRatio: ImageAspectRatio;
  seed?: number;
  apiKey: string;
  fetchImpl: typeof fetch;
}): Promise<FalSuccessResponse> {
  const body: Record<string, unknown> = {
    prompt: args.prompt,
    image_size: ASPECT_RATIO_TO_IMAGE_SIZE[args.aspectRatio],
    num_inference_steps: 4,
    num_images: 1,
    enable_safety_checker: true,
  };
  if (typeof args.seed === "number") body.seed = args.seed;

  const res = await args.fetchImpl(FAL_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Key ${args.apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ImageGenProviderError(
      `fal.ai ${res.status}: ${text.slice(0, 200)}`,
      res.status,
      text,
    );
  }

  const data = (await res.json()) as FalSuccessResponse;
  if (!data.images?.length || !data.images[0]?.url) {
    throw new ImageGenProviderError(
      "fal.ai returned empty images array",
      502,
      JSON.stringify(data).slice(0, 200),
    );
  }
  return data;
}

/* ------------------------- Main entry point -------------------------- */

/**
 * Generate an image, commit it to the client repo (if provisioned), and
 * persist the round-trip to the learning table.
 *
 * Failure modes (all persisted to instinct_site_image_generations so no
 * request ever disappears):
 *   - FAL_API_KEY missing → throws ImageGenNotConfiguredError BEFORE
 *     inserting (nothing happened — same contract as brief-edit).
 *   - fal.ai 4xx/5xx      → inserts row with image_url='' and repo
 *                            committed=false, then throws
 *                            ImageGenProviderError.
 *   - repo commit fails   → inserts row with fal CDN URL + repo
 *                            committed=false (no throw — the image still
 *                            works, just via fal's CDN instead of the
 *                            client's repo). Event emits image_gen_failed
 *                            with reason=repo_commit_failed so ops sees
 *                            it but the user isn't blocked.
 */
export async function generateImage(
  input: GenerateImageInput,
): Promise<GenerateImageResult> {
  const apiKey = process.env.FAL_API_KEY;
  if (!apiKey) {
    trackEvent("site.image_gen_failed", input.userId, input.userRole, {
      project_id: input.projectId,
      reason: "not_configured",
    });
    throw new ImageGenNotConfiguredError();
  }

  const generationId = `img_gen_${randomUUID()}`;
  const aspectRatio: ImageAspectRatio = input.aspectRatio ?? "16:9";
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  const t0 = Date.now();

  let fal: FalSuccessResponse;
  try {
    fal = await callFalAi({
      prompt: input.prompt,
      aspectRatio,
      seed: input.seed,
      apiKey,
      fetchImpl,
    });
  } catch (err) {
    const latencyMs = Date.now() - t0;
    // Persist the failed attempt so the brain learns which prompts
    // crash the provider (moderation blocks, prompt engineering
    // mistakes, etc.). image_url='' keeps the NOT NULL constraint
    // happy.
    await insertImageGeneration({
      id: generationId,
      projectId: input.projectId,
      requestedBy: input.userId,
      prompt: input.prompt,
      aspectRatio,
      seed: input.seed,
      model: IMAGE_GEN_MODEL,
      imageUrl: "",
      repoCommitted: false,
      costCents: 0,
      latencyMs,
    }).catch(() => {
      // safeQuery swallows DB errors already; the outer .catch here is
      // belt+suspenders so a logging failure can't suppress the real
      // fal error we're about to re-throw.
    });
    trackEvent("site.image_gen_failed", input.userId, input.userRole, {
      project_id: input.projectId,
      reason:
        err instanceof ImageGenProviderError
          ? `provider_${err.status}`
          : "provider_error",
      latency_ms: latencyMs,
    });
    throw err;
  }

  const falUrl = fal.images[0].url;
  const seed = fal.seed ?? input.seed;

  // Commit the bytes to the client's repo so the deployed site doesn't
  // depend on fal.ai's CDN TTL. If the repo isn't provisioned yet, fall
  // back to the fal URL so draft sites still work.
  let finalUrl = falUrl;
  let repoCommitted = false;
  if (input.githubRepo) {
    try {
      const bytesRes = await fetchImpl(falUrl);
      if (!bytesRes.ok) {
        throw new Error(
          `fal CDN ${bytesRes.status} when downloading generated image`,
        );
      }
      const arrayBuffer = await bytesRes.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      const client = input.githubClient ?? defaultGithubClient();
      const path = `public/generated/${generationId}.jpg`;
      await putFile(
        client,
        input.githubRepo,
        path,
        buffer,
        `chore(sites): generated image ${generationId}`,
      );
      finalUrl = `https://raw.githubusercontent.com/${input.githubRepo}/main/${path}`;
      repoCommitted = true;
    } catch (err) {
      // Commit failure is NOT fatal — the image still works via fal's
      // CDN. Emit the failure so ops sees it, but return the result
      // anyway (repo_committed=false) so the user isn't blocked.
      trackEvent("site.image_gen_failed", input.userId, input.userRole, {
        project_id: input.projectId,
        generation_id: generationId,
        reason: "repo_commit_failed",
        message: (err as Error).message.slice(0, 200),
      });
    }
  }

  const latencyMs = Date.now() - t0;

  await insertImageGeneration({
    id: generationId,
    projectId: input.projectId,
    requestedBy: input.userId,
    prompt: input.prompt,
    aspectRatio,
    seed,
    model: IMAGE_GEN_MODEL,
    imageUrl: finalUrl,
    repoCommitted,
    costCents: COST_CENTS_PER_IMAGE,
    latencyMs,
  });

  trackEvent("site.image_gen_succeeded", input.userId, input.userRole, {
    project_id: input.projectId,
    generation_id: generationId,
    aspect_ratio: aspectRatio,
    prompt_length: input.prompt.length,
    latency_ms: latencyMs,
    cost_cents: COST_CENTS_PER_IMAGE,
    repo_committed: repoCommitted,
    model: IMAGE_GEN_MODEL,
  });

  return {
    generationId,
    url: finalUrl,
    repoCommitted,
    latencyMs,
    model: IMAGE_GEN_MODEL,
    seed: typeof seed === "number" ? seed : undefined,
    costCents: COST_CENTS_PER_IMAGE,
  };
}

/* ------------------------- Prompt validation -------------------------- */

export const MAX_PROMPT_LEN = 500;
export const DAILY_CAP = 50;

// Deliberately small, extendable blocklist. The intent isn't a perfect
// content filter (fal.ai runs its own NSFW checker) — it's a
// zero-token first line that rejects obvious misuse before we spend
// cents on it. Grows over time with user reports.
const BLOCKED_KEYWORDS: RegExp[] = [
  /\bnsfw\b/i,
  /\bnude\b/i,
  /\bnaked\b/i,
  /\bexplicit\b/i,
  /\bporn\w*/i,
  /\bchild\b.*\bsexual/i,
  /\bgore\b/i,
  /\bbeheading\b/i,
];

// Common PII patterns we reject up front. Not exhaustive — the point is
// to stop a user pasting their own phone number / email into a prompt
// (which the model would happily burn into the image).
const PII_PATTERNS: RegExp[] = [
  // Email
  /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/,
  // US phone — optional country code + 10 digits with common separators.
  /(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/,
];

export interface PromptCheckOk {
  ok: true;
}
export interface PromptCheckFail {
  ok: false;
  reason: "prompt_too_long" | "prompt_blocked" | "prompt_empty";
  detail?: string;
}

export type PromptCheckResult = PromptCheckOk | PromptCheckFail;

/**
 * Pure function — checks length, blocked keywords, and obvious PII. The
 * route wires this up BEFORE calling generateImage() so we never burn a
 * fal credit on a prompt we'd reject.
 */
export function checkPrompt(prompt: string): PromptCheckResult {
  const trimmed = prompt.trim();
  if (trimmed.length === 0) return { ok: false, reason: "prompt_empty" };
  if (trimmed.length > MAX_PROMPT_LEN) {
    return {
      ok: false,
      reason: "prompt_too_long",
      detail: `Prompt is ${trimmed.length} characters — max is ${MAX_PROMPT_LEN}.`,
    };
  }
  for (const re of BLOCKED_KEYWORDS) {
    if (re.test(trimmed)) {
      return {
        ok: false,
        reason: "prompt_blocked",
        detail: "Prompt contains content we don't generate. Please rephrase.",
      };
    }
  }
  for (const re of PII_PATTERNS) {
    if (re.test(trimmed)) {
      return {
        ok: false,
        reason: "prompt_blocked",
        detail:
          "Prompt looks like it contains personal info (email / phone). Remove it and try again.",
      };
    }
  }
  return { ok: true };
}
