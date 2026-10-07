/**
 * POST /api/forcefield/stripe-webhook
 *
 * PUBLIC: unauthenticated by design - Stripe calls it. It is locked down by the
 * Stripe-Signature HMAC (verified with the webhook signing secret), not a session.
 * INERT until STRIPE_WEBHOOK_SECRET is set: with no secret it returns 501
 * disabled, so the route ships safe and goes live the moment the secret is
 * configured. Keeps our tenant subscription state in sync with Stripe.
 *
 * Never 500s: an unhandled event type returns 200 (so Stripe does not retry
 * forever); only a bad/missing signature is 400.
 */
import { NextRequest, NextResponse } from "next/server";
import { recordAudit, extractRequestMetadata } from "@/lib/audit-log";
import { setTenantBilling } from "@/lib/forcefield-web/billing";
import { verifyStripeSignature, subscriptionEventToBilling } from "@/lib/forcefield-web/billing-stripe";
import { trackEvent } from "@/lib/analytics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json({ ok: false, error: "billing_disabled" }, { status: 501 });
  }
  const rawBody = await req.text();
  const sig = req.headers.get("stripe-signature");
  if (!verifyStripeSignature(rawBody, sig, secret)) {
    return NextResponse.json({ ok: false, error: "bad_signature" }, { status: 400 });
  }

  let event: unknown;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ ok: false, error: "bad_payload" }, { status: 400 });
  }

  const mapped = subscriptionEventToBilling(event as Parameters<typeof subscriptionEventToBilling>[0]);
  if (!mapped) {
    // A verified event we do not act on (not a subscription event, or no tenant id).
    return NextResponse.json({ ok: true, handled: false });
  }

  await setTenantBilling(mapped.tenantId, mapped.input);
  const meta = extractRequestMetadata(req);
  await recordAudit({
    actor: { user_id: "stripe", role: "system" },
    action: "forcefield.tenant_license_updated",
    resourceType: "forcefield_tenant",
    resourceId: mapped.tenantId,
    ipAddress: meta.ipAddress, userAgent: meta.userAgent, requestId: meta.requestId,
    afterState: { status: mapped.input.status, provider: "stripe" },
  }).catch(() => {});
  void trackEvent("forcefield.tenant_license_updated", "stripe", "system", {
    tenantId: mapped.tenantId, status: String(mapped.input.status ?? ""), provider: "stripe",
  });
  return NextResponse.json({ ok: true, handled: true });
}
