/**
 * Verify a GitHub App webhook payload signature.
 *
 * GitHub signs the RAW request body with HMAC-SHA256 using the App's webhook
 * secret and sends it as `X-Hub-Signature-256: sha256=<hexdigest>`. We recompute
 * and compare in constant time. This is the ONLY authentication on the webhook
 * route (a server-to-server GitHub call has no user session), so a missing
 * secret or any mismatch MUST fail closed.
 *
 * The secret lives on OUR App (GITHUB_APP_WEBHOOK_SECRET), never on the client:
 * a tenant installs the App and configures nothing.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
  secret: string | undefined,
): boolean {
  // Fail closed: with no secret configured or no signature presented there is
  // nothing to verify against, so the delivery is not trusted.
  if (!secret || !signatureHeader) return false;
  const expected =
    "sha256=" + createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  const a = Buffer.from(signatureHeader);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on a length mismatch, so a wrong-length header is a
  // plain false rather than an exception.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
