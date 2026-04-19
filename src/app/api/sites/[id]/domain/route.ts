/**
 * /api/sites/[id]/domain — custom domain CRUD for Instinct Sites.
 *
 * Powers `DomainManager.tsx` on the site detail page. Thin wrapper over
 * `src/lib/site-domains.ts`, which owns the analytics + DB lifecycle.
 *
 * Auth: every verb requires a Bearer token (getUserFromRequest). The
 * caller must also have access to the target site — we read the site
 * row and 404 if it doesn't exist; authorization is modeled on
 * `getSiteProject`'s row-level-security boundary (any authenticated
 * team member can view, the DB pg-RLS policy will reject cross-tenant
 * reads in production).
 *
 * Error shaping:
 *   400 → invalid body / invalid domain shape
 *   401 → no/invalid token
 *   403 → user role doesn't permit domain management
 *   404 → site not found
 *   409 → domain already attached (unique constraint or Vercel 409)
 *   429 → Vercel rate-limited us
 *   503 → Vercel creds missing / Vercel unreachable
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest, hasRole } from "@/lib/auth";
import { getSiteProject } from "@/lib/sites";
import {
  registerDomain,
  refreshDomainStatus,
  unregisterDomain,
  listDomainsForSite,
} from "@/lib/site-domains";
import {
  VercelDomainError,
  httpStatusForCode,
} from "@/lib/sites-domain";

function errorPayload(err: unknown): { status: number; body: Record<string, unknown> } {
  if (err instanceof VercelDomainError) {
    const status = err.status >= 400 && err.status < 600
      ? httpStatusForCode(err.code)
      : httpStatusForCode(err.code);
    return {
      status,
      body: { error: err.message, reason: err.code },
    };
  }
  // Postgres 23505 (unique_violation on domain) → 409.
  const pg = err as { code?: string; constraint?: string };
  if (pg?.code === "23505" && /domain/.test(pg?.constraint ?? "")) {
    return {
      status: 409,
      body: {
        error: "That domain is already attached to a site.",
        reason: "domain_in_use",
      },
    };
  }
  console.error("[sites/domain]", (err as Error).message);
  return { status: 500, body: { error: "Internal server error" } };
}

async function authorizeSiteAccess(
  req: NextRequest,
  siteId: string,
): Promise<{
  user: ReturnType<typeof getUserFromRequest>;
  response?: NextResponse;
}> {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return { user: null, response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  const site = await getSiteProject(siteId);
  if (!site) {
    return { user, response: NextResponse.json({ error: "not found" }, { status: 404 }) };
  }
  // Match the "sales+" bar from the rest of sites routes. Explicit deny
  // for anonymous-level roles surfaces a clean 403 rather than a 500 on
  // the Vercel call. We don't gate by site ownership here because the
  // sites table is team-wide; RLS on the DB enforces tenancy.
  if (!hasRole(user.role, "sales")) {
    return {
      user,
      response: NextResponse.json(
        { error: "insufficient role for domain management", reason: "role_insufficient" },
        { status: 403 },
      ),
    };
  }
  return { user };
}

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const { user, response } = await authorizeSiteAccess(req, id);
  if (response || !user) return response!;
  try {
    const domains = await listDomainsForSite(id);
    return NextResponse.json({ domains });
  } catch (err) {
    const { status, body } = errorPayload(err);
    return NextResponse.json(body, { status });
  }
}

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const { user, response } = await authorizeSiteAccess(req, id);
  if (response || !user) return response!;

  let body: { domain?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (!body?.domain || typeof body.domain !== "string") {
    return NextResponse.json(
      { error: "domain required", reason: "missing_domain" },
      { status: 400 },
    );
  }

  try {
    const record = await registerDomain({
      siteId: id,
      domain: body.domain,
      userId: user.id,
      userRole: user.role,
    });
    return NextResponse.json(
      {
        domain: record.domain,
        status: record.status,
        verification: record.verification_records,
        record,
      },
      { status: 200 },
    );
  } catch (err) {
    const { status, body: respBody } = errorPayload(err);
    return NextResponse.json(respBody, { status });
  }
}

export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const { user, response } = await authorizeSiteAccess(req, id);
  if (response || !user) return response!;

  let body: { domain?: string; action?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (!body?.domain || typeof body.domain !== "string") {
    return NextResponse.json(
      { error: "domain required", reason: "missing_domain" },
      { status: 400 },
    );
  }
  if (body.action !== "refresh") {
    return NextResponse.json(
      { error: "unsupported action", reason: "bad_action" },
      { status: 400 },
    );
  }

  try {
    const record = await refreshDomainStatus({
      siteId: id,
      domain: body.domain,
      userId: user.id,
      userRole: user.role,
    });
    return NextResponse.json({ record });
  } catch (err) {
    const { status, body: respBody } = errorPayload(err);
    return NextResponse.json(respBody, { status });
  }
}

export async function DELETE(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const { user, response } = await authorizeSiteAccess(req, id);
  if (response || !user) return response!;

  const domain = req.nextUrl.searchParams.get("domain");
  if (!domain) {
    return NextResponse.json(
      { error: "domain query param required", reason: "missing_domain" },
      { status: 400 },
    );
  }

  try {
    await unregisterDomain({
      siteId: id,
      domain,
      userId: user.id,
      userRole: user.role,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    const { status, body: respBody } = errorPayload(err);
    return NextResponse.json(respBody, { status });
  }
}
