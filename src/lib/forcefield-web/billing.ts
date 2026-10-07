/**
 * Forcefield licensing + subscription model. ONE model serves both paths:
 *   - MANUAL: an existing client we license directly (operator sets plan + status;
 *     provider "manual", no Stripe).
 *   - STRIPE: self-serve SaaS (a Stripe webhook calls setTenantBilling with the
 *     status + period end; provider "stripe", billingRef = the Stripe id).
 *
 * DECOUPLED from the ingest/decision path by design: the hard entitlement kill is
 * forcefield_tenants.status (see tenants.ts). This records the COMMERCIAL state and
 * powers the admin UI + a future auto-disable job, so billing can never break an
 * active tenant's protection. Everything is injectable + never throws.
 */
import { safeQuery } from "@/lib/db";

export type ForcefieldPlan = "none" | "starter" | "growth" | "scale" | "enterprise";
export type SubscriptionStatus = "none" | "trialing" | "active" | "past_due" | "canceled";
export type BillingProviderName = "manual" | "stripe";

export const FORCEFIELD_PLANS: readonly ForcefieldPlan[] = ["none", "starter", "growth", "scale", "enterprise"];
export const SUBSCRIPTION_STATUSES: readonly SubscriptionStatus[] = ["none", "trialing", "active", "past_due", "canceled"];

/** Plan catalog (reference, no prices - pricing numbers are a business DECISION;
 *  see docs/forcefield/pricing-and-packaging.md). */
export const PLAN_CATALOG: Record<Exclude<ForcefieldPlan, "none">, { label: string; sites: string }> = {
  starter: { label: "Starter", sites: "1 site" },
  growth: { label: "Growth", sites: "multi-site" },
  scale: { label: "Scale", sites: "many + SLA" },
  enterprise: { label: "Enterprise", sites: "custom" },
};

export interface TenantBilling {
  plan: ForcefieldPlan;
  status: SubscriptionStatus;
  provider: BillingProviderName;
  billingRef: string | null;
  currentPeriodEnd: string | null;
}

export type BillingQuery = <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;
const liveQuery: BillingQuery = async (sql, params) => (await safeQuery(sql, params ?? [])).rows as never;

function isPlan(v: string): v is ForcefieldPlan {
  return (FORCEFIELD_PLANS as readonly string[]).includes(v);
}
function isStatus(v: string): v is SubscriptionStatus {
  return (SUBSCRIPTION_STATUSES as readonly string[]).includes(v);
}

type BillingRow = {
  plan: string; subscription_status: string; billing_provider: string;
  billing_ref: string | null; current_period_end: string | null;
};
function rowToBilling(r: BillingRow): TenantBilling {
  return {
    plan: isPlan(r.plan) ? r.plan : "none",
    status: isStatus(r.subscription_status) ? r.subscription_status : "none",
    provider: r.billing_provider === "stripe" ? "stripe" : "manual",
    billingRef: r.billing_ref,
    currentPeriodEnd: r.current_period_end,
  };
}

/** The deterministic entitlement decision: is this tenant currently licensed?
 *  active or trialing counts; a status with a period end in the past does not.
 *  (Advisory today - it does NOT gate ingest; it informs the UI + jobs.) */
export function isLicensed(b: Pick<TenantBilling, "status" | "currentPeriodEnd">, nowMs: number = Date.now()): boolean {
  if (b.status !== "active" && b.status !== "trialing") return false;
  if (b.currentPeriodEnd) {
    const end = Date.parse(b.currentPeriodEnd);
    if (!Number.isNaN(end) && end < nowMs) return false;
  }
  return true;
}

export async function getTenantBilling(id: string, q: BillingQuery = liveQuery): Promise<TenantBilling | null> {
  try {
    const [row] = await q<BillingRow>(
      `SELECT plan, subscription_status, billing_provider, billing_ref, current_period_end::text AS current_period_end
         FROM forcefield_tenants WHERE id = $1`,
      [id],
    );
    return row ? rowToBilling(row) : null;
  } catch {
    return null;
  }
}

export interface SetBillingInput {
  plan?: ForcefieldPlan;
  status?: SubscriptionStatus;
  provider?: BillingProviderName;
  billingRef?: string | null;
  currentPeriodEnd?: string | null;
}

/**
 * Set a tenant's licensing/subscription state. Used by the operator (manual
 * license) AND by the Stripe webhook when it lands (same seam). Only the provided
 * fields change. Returns false on invalid enum / unknown id / write error.
 */
export async function setTenantBilling(id: string, input: SetBillingInput, q: BillingQuery = liveQuery): Promise<boolean> {
  if (input.plan && !isPlan(input.plan)) return false;
  if (input.status && !isStatus(input.status)) return false;
  if (input.provider && input.provider !== "manual" && input.provider !== "stripe") return false;

  const sets: string[] = [];
  const params: unknown[] = [id];
  const add = (col: string, val: unknown) => { params.push(val); sets.push(`${col} = $${params.length}`); };
  if (input.plan !== undefined) add("plan", input.plan);
  if (input.status !== undefined) add("subscription_status", input.status);
  if (input.provider !== undefined) add("billing_provider", input.provider);
  if (input.billingRef !== undefined) add("billing_ref", input.billingRef);
  if (input.currentPeriodEnd !== undefined) add("current_period_end", input.currentPeriodEnd);
  if (sets.length === 0) return false;

  try {
    const rows = await q<{ id: string }>(
      `UPDATE forcefield_tenants SET ${sets.join(", ")}, updated_at = now() WHERE id = $1 RETURNING id`,
      params,
    );
    return rows.length > 0;
  } catch {
    return false;
  }
}

/**
 * ENFORCE-TO-PAID gate (the pure, deterministic core).
 *
 * Watching is free; actually turning a request away is a paid capability. This
 * function answers one question: given a tenant's license state, may the engine
 * ACT on a would-be block? It does NOT decide whether a request is hostile
 * (that is decideEnforcement, unchanged) - it only decides whether we are allowed
 * to enforce the block we already computed.
 *
 *   licensed === true   -> entitled (active/trialing tenant: enforce for real).
 *   licensed === false  -> NOT entitled (a known tenant without a live license:
 *                          watch only, record what we WOULD have blocked, and
 *                          surface the upgrade). This is the free-tier experience.
 *   licensed === null   -> UNMANAGED: no billing tenant resolves for this site
 *                          (our own first-party sites, internal/self-hosted
 *                          deployments). Not a SaaS customer, so the paid gate
 *                          does not apply and enforcement follows the env/posture
 *                          config as it always has. Non-regressive by design.
 *
 * Pure + synchronous so it is trivially testable and safe on the hot path; the
 * I/O (resolving `licensed`) is the caller's, done ONLY when a block is pending.
 */
export function entitledToBlock(licensed: boolean | null): boolean {
  return licensed !== false;
}

/**
 * Resolve the block-entitlement for a site label, centrally (never from a signal
 * the client controls, so a customer cannot self-upgrade by editing their shim).
 *
 * Returns:
 *   true  -> an active, licensed tenant owns this site.
 *   false -> an active tenant owns this site but has no live license (free tier).
 *   null  -> no active tenant row for this site (unmanaged / first-party) OR the
 *            lookup failed. null is fail-OPEN for the gate (enforcement proceeds),
 *            matching the route's fail-open posture: a billing-table hiccup must
 *            never silently disable a paying customer's protection.
 */
export async function getSiteBlockEntitlement(site: string, q: BillingQuery = liveQuery): Promise<boolean | null> {
  const label = (site ?? "").trim();
  if (!label) return null;
  try {
    const rows = await q<BillingRow>(
      `SELECT plan, subscription_status, billing_provider, billing_ref,
              current_period_end::text AS current_period_end
         FROM forcefield_tenants
        WHERE site_label = $1 AND status = 'active'
        ORDER BY created_at DESC
        LIMIT 1`,
      [label],
    );
    if (rows.length === 0) return null; // unmanaged site: paid gate does not apply.
    return isLicensed(rowToBilling(rows[0]));
  } catch {
    return null; // fail-open: never let a billing read take a customer's block away.
  }
}
