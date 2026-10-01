/**
 * Non-interactive auth for the factory's own endpoints, so the self-driving loop
 * needs NO human to mint a login before every run (the single mid-process human
 * gate that stopped the tool from being self-maintaining).
 *
 * A headless run presents a scoped SERVICE TOKEN (header x-factory-token), matched
 * constant-time against FACTORY_SERVICE_TOKEN (same shared-secret pattern as the
 * ingest endpoints). On a match it yields a synthetic identity scoped to the
 * factory workspace with ONLY the capabilities the factory routes check - nothing
 * else. No token (or no env secret set) falls through to exactly today's user
 * capability auth, so the endpoint can never be opened by default and existing
 * human access is unchanged. Revoke by rotating the env var.
 */
import type { NextRequest } from "next/server";
import { timingSafeEqual } from "crypto";
import type { TeamMember } from "@/lib/auth";
import type { Capability } from "@/lib/auth/capabilities";
import { requireCapability, type RequireCapabilityResult } from "@/lib/auth/require-capability";

/** Exactly what the pipeline + ci-fix routes check - least privilege, not ALL_CAPS. */
const SERVICE_CAPS: readonly Capability[] = [
  "settings.manage_team",
  "analytics.view",
  "analytics.triage",
  "forcefield.view",
];

function presentedToken(req: NextRequest): string | null {
  const t = (req.headers.get("x-factory-token") ?? "").trim();
  return t.length > 0 ? t : null;
}

/** Constant-time compare. Unset / too-short secret never matches: the service path
 *  is OFF until an operator deliberately sets a real token. */
export function factoryTokenMatches(presented: string | null): boolean {
  const secret = process.env.FACTORY_SERVICE_TOKEN;
  if (!secret || secret.length < 16 || !presented) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(secret);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** The synthetic factory service identity (scoped workspace + factory caps only). */
function serviceIdentity(): RequireCapabilityResult {
  const workspaceId = process.env.FACTORY_SERVICE_WORKSPACE || "default";
  const user: TeamMember = {
    id: "instinct.ai_code.service",
    email: "factory-service@thewolfpack.agency",
    name: "Factory Service",
    role: "cto",
    workspaceId,
    created_at: "2026-01-01T00:00:00.000Z",
  };
  return { ok: true, user, capabilities: new Set<Capability>(SERVICE_CAPS) };
}

/**
 * Factory endpoint auth: service token first (headless), else normal user auth.
 * Drop-in replacement for requireCapability on the factory routes.
 */
export async function requireFactoryServiceOrCapability(
  req: NextRequest,
  capability: Capability,
): Promise<RequireCapabilityResult> {
  if (factoryTokenMatches(presentedToken(req))) return serviceIdentity();
  return requireCapability(req, capability);
}
