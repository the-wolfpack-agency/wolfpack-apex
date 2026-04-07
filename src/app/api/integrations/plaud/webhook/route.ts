/**
 * Plaud webhook endpoint.
 *
 * Plaud calls this URL when a meeting recording finishes transcribing.
 * Auth: HMAC-SHA256 of the raw request body, sent in the Plaud-Signature
 * header. PLAUD_WEBHOOK_SECRET in env is the shared secret.
 *
 * IMPORTANT: signature verification MUST happen against the unparsed
 * request body bytes — JSON serialization differs and breaks the HMAC.
 * That's why we read req.text() first and parse manually.
 *
 * Idempotent: re-deliveries are upserted (file_id is unique). The
 * ingestion pipeline will return status:"duplicate" on a re-delivery.
 */

import { NextRequest, NextResponse } from "next/server";
import { trackEvent } from "@/lib/analytics";
import {
  verifyPlaudSignature,
  ingestTranscript,
  type PlaudWebhookPayload,
} from "@/lib/plaud";

export async function POST(req: NextRequest) {
  // 1. Read the RAW body for signature verification
  const rawBody = await req.text();
  const signature = req.headers.get("Plaud-Signature") || req.headers.get("plaud-signature");

  trackEvent("plaud.webhook_received", "system", "system", {
    has_signature: signature ? 1 : 0,
    body_bytes: rawBody.length,
  });

  // 2. Verify signature (timing-safe)
  if (!verifyPlaudSignature(rawBody, signature)) {
    trackEvent("plaud.signature_invalid", "system", "system", {
      had_header: signature ? 1 : 0,
    });
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  // 3. Parse payload
  let payload: PlaudWebhookPayload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!payload.event_type || !payload.data?.file_id) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  // 4. Dispatch by event type
  if (payload.event_type === "audio_transcribe.completed") {
    const result = await ingestTranscript(payload.data.file_id);
    return NextResponse.json({ ok: true, result });
  }

  // Unknown event type — return 200 so Plaud doesn't retry, but log it
  trackEvent("plaud.webhook_received", "system", "system", {
    event_type: payload.event_type,
    note: "unhandled_event_type",
  });
  return NextResponse.json({ ok: true, ignored: payload.event_type });
}
