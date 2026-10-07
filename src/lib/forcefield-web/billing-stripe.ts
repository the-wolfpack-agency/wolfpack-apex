/**
 * Stripe billing sync, dependency-free (no Stripe SDK, no new runtime dep). Pure
 * functions the webhook route uses: verify the Stripe-Signature header with node
 * crypto, and map a Stripe subscription event to our tenant billing update.
 *
 * This is the self-serve SaaS half that keeps our subscription state in sync; it
 * is INERT until STRIPE_WEBHOOK_SECRET is set (the route returns disabled), so it
 * ships safe and goes live the moment the secret is configured. Checkout (creating
 * the subscription) is the remaining creds-gated piece - it needs the Stripe API.
 *
 * The Stripe subscription MUST carry our tenant id in metadata.forcefield_tenant_id
 * (set at checkout) so the webhook can attribute it.
 */
import { createHmac, timingSafeEqual } from "crypto";
import type { SetBillingInput, SubscriptionStatus } from "./billing";

/** Verify a Stripe-Signature header: "t=<ts>,v1=<sig>[,v1=<sig>]". The signed
 *  payload is `${t}.${rawBody}`, HMAC-SHA256 with the signing secret. Constant-time
 *  compare against any provided v1. Rejects a timestamp outside the tolerance. */
export function verifyStripeSignature(
  rawBody: string,
  sigHeader: string | null,
  secret: string,
  nowSec: number = Math.floor(Date.now() / 1000),
  toleranceSec = 300,
): boolean {
  if (!sigHeader || !secret) return false;
  let t = "";
  const v1: string[] = [];
  for (const part of sigHeader.split(",")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === "t") t = v;
    else if (k === "v1") v1.push(v);
  }
  if (!t || v1.length === 0) return false;
  const ts = Number(t);
  if (!Number.isFinite(ts) || Math.abs(nowSec - ts) > toleranceSec) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  const exp = Buffer.from(expected, "utf8");
  return v1.some((sig) => {
    const got = Buffer.from(sig, "utf8");
    return got.length === exp.length && timingSafeEqual(got, exp);
  });
}

/** Map a Stripe subscription.status to our SubscriptionStatus (conservative). */
export function mapStripeStatus(s: string): SubscriptionStatus {
  switch (s) {
    case "active": return "active";
    case "trialing": return "trialing";
    case "past_due": return "past_due";
    case "canceled":
    case "unpaid":
    case "incomplete_expired": return "canceled";
    default: return "none";
  }
}

interface StripeSubscriptionEvent {
  type?: string;
  data?: { object?: {
    id?: string;
    status?: string;
    current_period_end?: number;
    metadata?: { forcefield_tenant_id?: string; forcefield_plan?: string };
  } };
}

/** Extract the tenant billing update from a Stripe subscription.* event, or null
 *  when it is not a subscription event we handle or carries no tenant id. */
export function subscriptionEventToBilling(event: StripeSubscriptionEvent): { tenantId: string; input: SetBillingInput } | null {
  if (!event?.type?.startsWith("customer.subscription.")) return null;
  const obj = event.data?.object;
  const tenantId = obj?.metadata?.forcefield_tenant_id;
  if (!obj || !tenantId) return null;
  const status = event.type === "customer.subscription.deleted" ? "canceled" : mapStripeStatus(String(obj.status ?? ""));
  const input: SetBillingInput = {
    status,
    provider: "stripe",
    billingRef: obj.id ?? null,
    currentPeriodEnd: obj.current_period_end ? new Date(obj.current_period_end * 1000).toISOString() : null,
  };
  const plan = obj.metadata?.forcefield_plan;
  if (plan) input.plan = plan as SetBillingInput["plan"];
  return { tenantId, input };
}
