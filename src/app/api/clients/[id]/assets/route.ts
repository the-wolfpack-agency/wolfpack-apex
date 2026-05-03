/**
 * /api/clients/[id]/assets — per-client ASSET LIBRARY (Path C Phase 1, Stream P3).
 *
 * Semantic note: the `[id]` URL param is the client's `client_slug`
 * (TEXT), matching the column on `instinct_client_assets`. Next.js
 * forbids `[id]` and `[slug]` as sibling dynamic segments under the
 * same parent, so we reuse the existing `[id]` folder and treat its
 * value as a slug in this handler. The UI component and the E2E test
 * refer to the same value as `clientSlug` for clarity — it's the same
 * string end-to-end.
 *
 * GET  → list active assets (filter by ?kind=). Capability:
 *         `clients.view` (matches sibling `/api/clients/[id]/route.ts`).
 * POST → upload a new asset. Body:
 *   {
 *     filename: string,
 *     content_base64: string,  // raw file bytes, base64-encoded
 *     mime: string,
 *     kind: "logo" | "photo" | "illustration" | "icon" | "other",
 *     alt_text?: string
 *   }
 *         Capability: `clients.edit`.
 *
 * Dedupe: we SHA-256 the decoded bytes and let recordAssetUpload
 * collapse duplicates — the same file uploaded twice bumps use_count
 * on the existing row instead of creating a new one.
 */

import { NextRequest, NextResponse } from "next/server";
import { createHash, randomUUID } from "node:crypto";
import { requireCapability } from "@/lib/auth/require-capability";
import { recordAudit, extractRequestMetadata } from "@/lib/audit-log";
import { sanitizeForLog } from "@/lib/log-sanitize";
import {
  listAssetsForClient,
  recordAssetUpload,
  saveAssetBlob,
  type ClientAssetKind,
} from "@/lib/client-assets";

const MAX_BYTES = 8 * 1024 * 1024; // 8 MB per asset — matches /api/sites/[id]/assets
const ALLOWED_MIMES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/svg+xml",
]);
const VALID_KINDS: ReadonlySet<ClientAssetKind> = new Set([
  "logo",
  "photo",
  "illustration",
  "icon",
  "other",
]);

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const auth = await requireCapability(req, "clients.view");
  if (!auth.ok) return auth.response;

  const { id: clientSlug } = await context.params;
  const kindParam = req.nextUrl.searchParams.get("kind");
  const kind: ClientAssetKind | undefined =
    kindParam && VALID_KINDS.has(kindParam as ClientAssetKind)
      ? (kindParam as ClientAssetKind)
      : undefined;
  const assets = await listAssetsForClient(clientSlug, kind ? { kind } : undefined);
  return NextResponse.json({ assets });
}

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const auth = await requireCapability(req, "clients.edit");
  if (!auth.ok) return auth.response;
  const user = auth.user;

  const { id: clientSlug } = await context.params;

  let body: {
    filename?: unknown;
    content_base64?: unknown;
    mime?: unknown;
    kind?: unknown;
    alt_text?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json body" }, { status: 400 });
  }

  const filename = typeof body.filename === "string" ? body.filename.trim() : "";
  const contentBase64 =
    typeof body.content_base64 === "string" ? body.content_base64 : "";
  const mime = typeof body.mime === "string" ? body.mime : "";
  const kindRaw = typeof body.kind === "string" ? body.kind : "";
  const altText = typeof body.alt_text === "string" ? body.alt_text : undefined;

  if (!filename || !contentBase64 || !mime || !kindRaw) {
    return NextResponse.json(
      { error: "filename, content_base64, mime, and kind are required" },
      { status: 400 },
    );
  }
  if (!VALID_KINDS.has(kindRaw as ClientAssetKind)) {
    return NextResponse.json(
      { error: `invalid kind: ${kindRaw} (allowed: ${[...VALID_KINDS].join(", ")})` },
      { status: 400 },
    );
  }
  if (!ALLOWED_MIMES.has(mime)) {
    return NextResponse.json(
      { error: `unsupported mime: ${mime} (allowed: ${[...ALLOWED_MIMES].join(", ")})` },
      { status: 400 },
    );
  }

  // Decode + size-check
  let buf: Buffer;
  try {
    buf = Buffer.from(contentBase64, "base64");
  } catch {
    return NextResponse.json({ error: "invalid base64 content" }, { status: 400 });
  }
  if (buf.byteLength === 0) {
    return NextResponse.json({ error: "empty file" }, { status: 400 });
  }
  if (buf.byteLength > MAX_BYTES) {
    return NextResponse.json(
      { error: `file too large (${MAX_BYTES} bytes max)` },
      { status: 413 },
    );
  }

  const sha256 = createHash("sha256").update(buf).digest("hex");
  // Mint the UUID up-front so the canonical URL can embed it without
  // a second UPDATE — keeps the INSERT's expectRows:1 invariant as the
  // single source of write-succeeded-or-throw.
  const assetId = randomUUID();
  // Sanitize filename — no path traversal, safe chars only.
  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
  const canonicalUrl = `/api/clients/${encodeURIComponent(clientSlug)}/assets/${assetId}/raw`;

  let asset;
  try {
    asset = await recordAssetUpload({
      id: assetId,
      clientSlug,
      assetKind: kindRaw as ClientAssetKind,
      filename: safeName,
      url: canonicalUrl,
      mime,
      sizeBytes: buf.byteLength,
      sha256,
      altText,
      uploadedBy: user.id,
    });
  } catch (err) {
    const msg = (err as Error).message ?? "upload failed";
    console.error("[clients/assets POST]", sanitizeForLog(msg));
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  // Persist the raw bytes keyed by the RETURNED asset id (dedupe hits
  // keep the original id; fresh inserts use our minted UUID). On
  // duplicates we skip re-saving — the blob is already there.
  const dedupedHit = asset.id !== assetId;
  if (!dedupedHit) {
    try {
      await saveAssetBlob(asset.id, buf.toString("base64"));
    } catch (err) {
      console.error("[clients/assets POST blob]", sanitizeForLog((err as Error).message));
      // Non-fatal — metadata row is committed; blob can be re-uploaded.
    }
  }

  // Audit trail — every mutation under /api/clients/* must audit
  // (audit-coverage.test.ts guardrail). We log the sha + kind but NOT
  // the filename so filename changes don't flood the audit log, and
  // NOT the raw bytes (obviously).
  try {
    await recordAudit({
      actor: { user_id: user.id, role: user.role },
      action: dedupedHit ? "client_asset.reused" : "client_asset.uploaded",
      resourceType: "client_asset",
      resourceId: asset.id,
      afterState: {
        client_slug: clientSlug,
        kind: asset.assetKind,
        size_bytes: asset.sizeBytes,
        sha256,
        deduped: dedupedHit,
      },
      ...extractRequestMetadata(req),
    });
  } catch (err) {
    // Audit write failure should not break the API response — the
    // observation trail is already in analytics via trackEvent.
    console.error("[clients/assets POST audit]", sanitizeForLog((err as Error).message));
  }

  return NextResponse.json({ asset }, { status: 201 });
}
