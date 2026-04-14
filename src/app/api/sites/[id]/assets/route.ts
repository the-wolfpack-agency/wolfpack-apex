/**
 * /api/sites/[id]/assets — upload an image asset for a site project.
 *
 * Multipart form: "file" + optional "altText". On upload:
 *   1. Validate type (image/*) + size cap
 *   2. Store row in apex_site_assets with a data URI in storage_url (v1)
 *   3. If the project already has a github_repo, commit the bytes to
 *      public/{filename} so the deployed site can reference it
 *   4. trackEvent('site.asset_uploaded')
 *
 * Returns { asset: { url, filename, mimeType, sizeBytes } } so the
 * client can immediately stitch the URL into the brief and re-deploy.
 *
 * Auth required.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import {
  getSiteProject,
  recordAssetUpload,
} from "@/lib/sites";
import { putFile, defaultGithubClient } from "@/lib/github-client";
import { trackEvent } from "@/lib/analytics";

const MAX_BYTES = 8 * 1024 * 1024; // 8 MB cap per asset

// Rate limit: 20 uploads per user per hour
const uploadAttempts = new Map<string, { count: number; resetAt: number }>();
const MAX_UPLOADS = 20;
const UPLOAD_WINDOW_MS = 60 * 60 * 1000;
const ALLOWED_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/svg+xml",
]);

export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Upload rate limiting
  const now = Date.now();
  const entry = uploadAttempts.get(user.id);
  if (entry && now < entry.resetAt) {
    entry.count++;
    if (entry.count > MAX_UPLOADS) {
      trackEvent("system.upload_rate_limited", user.id, user.role, { endpoint: "sites/assets" });
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      return NextResponse.json(
        { error: "Too many uploads. Please try again later." },
        { status: 429, headers: { "Retry-After": String(retryAfter) } },
      );
    }
  } else {
    uploadAttempts.set(user.id, { count: 1, resetAt: now + UPLOAD_WINDOW_MS });
  }

  const { id } = await context.params;
  const project = await getSiteProject(id);
  if (!project) return NextResponse.json({ error: "project not found" }, { status: 404 });

  let file: File;
  try {
    const form = await req.formData();
    const f = form.get("file");
    if (!(f instanceof File)) {
      return NextResponse.json({ error: "file required" }, { status: 400 });
    }
    file = f;
  } catch {
    return NextResponse.json({ error: "invalid multipart body" }, { status: 400 });
  }

  if (!ALLOWED_TYPES.has(file.type)) {
    return NextResponse.json(
      { error: `unsupported type ${file.type} (allowed: ${[...ALLOWED_TYPES].join(", ")})` },
      { status: 415 },
    );
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: `file too large (${MAX_BYTES} bytes max)` }, { status: 413 });
  }

  // Sanitize filename — keep only safe chars, no path traversal
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
  const repoPath = `public/${project.client_slug}/${safeName}`;
  const buffer = Buffer.from(await file.arrayBuffer());
  const storageUrl = `/${project.client_slug}/${safeName}`;

  // Commit to client repo if provisioned
  let committed = false;
  if (project.github_repo) {
    try {
      const client = defaultGithubClient();
      await putFile(
        client,
        project.github_repo,
        repoPath,
        buffer.toString("base64"),
        `chore: upload ${safeName} for ${project.client_slug}`,
      );
      committed = true;
    } catch (err) {
      // Non-fatal — record failure but still save row so user knows.
      console.error("[sites/assets] github commit failed:", (err as Error).message);
    }
  }

  await recordAssetUpload(
    id,
    safeName,
    file.type,
    file.size,
    storageUrl,
    user.id,
    user.role,
  );

  return NextResponse.json({
    asset: {
      url: storageUrl,
      filename: safeName,
      mimeType: file.type,
      sizeBytes: file.size,
      committed,
    },
  });
}
