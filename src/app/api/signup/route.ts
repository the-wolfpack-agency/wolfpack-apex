/**
 * Public self-serve signup for OGIAM. No auth (a prospective client has no
 * account yet), rate-limited per IP. Registers a tenant and kicks off
 * provisioning via signupTenant, which - by default, with no provider enabled -
 * leaves the tenant pending_provision and writes NOTHING into shared data.
 *
 * Returns the tenant id + status + a human message: 201 on success, 400 on
 * invalid input, 429 when rate-limited.
 */
import { NextRequest, NextResponse } from "next/server";
import { signupTenant } from "@/lib/tenancy/signup";
import { checkRateLimit } from "@/lib/ogiam/gate-rate-limit";
import { recordAudit } from "@/lib/audit-log";

/** Best-effort client IP for the rate-limit key (proxy headers, then fallback). */
function clientIp(req: NextRequest): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]!.trim();
  return req.headers.get("x-real-ip") ?? "unknown";
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const rl = await checkRateLimit(`signup:${clientIp(req)}`, { limit: 5, windowMs: 300_000 });
  if (!rl.ok) {
    return NextResponse.json({ ok: false, message: "Too many attempts. Try again shortly." }, { status: 429 });
  }

  let body: { orgName?: unknown; adminEmail?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    /* empty / malformed body falls through to validation in signupTenant */
  }

  const result = await signupTenant({
    orgName: typeof body.orgName === "string" ? body.orgName : "",
    adminEmail: typeof body.adminEmail === "string" ? body.adminEmail : "",
  });

  // A tenant registration is security-relevant, so record it in the tamper-evident
  // audit log (success only, and rate-limited above, so a public endpoint cannot
  // flood the chain). No PII: the actor is the system, and only the tenant id +
  // status are recorded - never the admin email.
  if (result.ok && result.tenantId) {
    await recordAudit({
      actor: { user_id: "self-serve", role: "system" },
      action: "tenancy.tenant_registered",
      resourceType: "tenant",
      resourceId: result.tenantId,
      afterState: { status: result.status ?? "pending_provision" },
    });
  }

  return NextResponse.json(result, { status: result.ok ? 201 : 400 });
}
