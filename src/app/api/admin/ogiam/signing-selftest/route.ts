/**
 * POST /api/admin/ogiam/signing-selftest
 *
 * Confirms the OGIAM checkpoint signing wiring end to end: it signs a
 * server-generated probe with the configured signer, then independently
 * verifies the signature. Use it the moment the Azure Key Vault env vars land to
 * prove the round trip works, without waiting for the hourly checkpoint sweep.
 *
 * Security posture:
 *   - Capability gated (settings.manage_team), the same gate as the rest of the
 *     OGIAM admin surface.
 *   - POST, not GET: it triggers an external signing operation (a side effect
 *     with cost), and a GET would be reachable by prefetch and CSRF.
 *   - It signs ONLY a server-generated probe (a random nonce), never any
 *     caller-supplied value, so it cannot be turned into a signing oracle.
 *   - Rate limited per user.
 *   - The response carries only status booleans and the PUBLIC key id. No
 *     signature bytes, no secrets, no env values. The presence (never the value)
 *     of each required env var is reported to help diagnose a partial config.
 *   - The action is audited (probing the signing infrastructure is
 *     security-relevant).
 *   - Never 500s on a recoverable condition.
 */

import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { requireCapability } from "@/lib/auth/require-capability";
import { recordAudit, extractRequestMetadata } from "@/lib/audit-log";
import { trackEvent } from "@/lib/analytics";
import { getSigner, runSignerSelfTest, readKeyVaultConfig } from "@/lib/ogiam/signing";

const WINDOW_MS = 60 * 1000;
const MAX_PER_WINDOW = 6;
const attempts = new Map<string, { count: number; windowStart: number }>();

export function _isRateLimited(userId: string, now = Date.now()): boolean {
  const entry = attempts.get(userId);
  if (!entry || now - entry.windowStart >= WINDOW_MS) {
    attempts.set(userId, { count: 1, windowStart: now });
    return false;
  }
  if (entry.count >= MAX_PER_WINDOW) return true;
  entry.count++;
  return false;
}

export function _resetRateLimit(): void {
  attempts.clear();
}

/** Report which required env vars are SET (boolean only, never the value). */
function configPresence(env: NodeJS.ProcessEnv): Record<string, boolean> {
  return {
    OGIAM_KEYVAULT_URL: Boolean(env.OGIAM_KEYVAULT_URL),
    OGIAM_KEYVAULT_KEY: Boolean(env.OGIAM_KEYVAULT_KEY),
    AZURE_TENANT_ID: Boolean(env.AZURE_TENANT_ID),
    AZURE_CLIENT_ID: Boolean(env.AZURE_CLIENT_ID),
    AZURE_CLIENT_SECRET: Boolean(env.AZURE_CLIENT_SECRET),
  };
}

export async function POST(req: NextRequest) {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  const { user } = auth;

  if (_isRateLimited(user.id)) {
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: { "Retry-After": "60" } },
    );
  }

  const presence = configPresence(process.env);
  const keyVaultConfigured = readKeyVaultConfig(process.env) !== null;

  try {
    const signer = getSigner();
    // Server-generated probe nonce: the caller never controls what is signed.
    const result = await runSignerSelfTest(signer, randomBytes(12).toString("hex"));

    // Audit: someone exercised the signing infrastructure. No secrets recorded.
    try {
      await recordAudit({
        actor: { user_id: user.id, role: user.role },
        action: "ogiam.signing_selftest",
        resourceType: "ogiam_signer",
        resourceId: result.mode,
        afterState: { mode: result.mode, signed: result.signed, verified: result.verified },
        ...extractRequestMetadata(req),
      });
    } catch (err) {
      console.warn("[ogiam selftest audit]", (err as Error).message);
    }

    trackEvent("ogiam.signing_selftest", user.id, user.role, {
      mode: result.mode,
      signed: result.signed,
      verified: result.verified,
      latency_ms: result.latencyMs,
    });

    // ok = the wiring is fully working (signed AND independently verified).
    return NextResponse.json({
      ok: result.signed && result.verified,
      mode: result.mode,
      is_production: result.isProduction,
      signed: result.signed,
      verified: result.verified,
      key_id: result.keyId,
      algorithm: result.algorithm,
      latency_ms: result.latencyMs,
      keyvault_configured: keyVaultConfigured,
      env_present: presence,
      message:
        result.mode === "none"
          ? "No signer configured. Set the OGIAM_KEYVAULT_* and AZURE_* env vars to enable Key Vault notarization."
          : result.signed && result.verified
            ? "Signing wiring verified: signed a probe and independently verified it."
            : "Signer is configured but the round trip did not verify. Check the key permissions and config.",
    });
  } catch (err) {
    // Never 500 on a recoverable condition; report a structured failure.
    console.error("[ogiam signing-selftest]", (err as Error).message);
    return NextResponse.json({
      ok: false,
      mode: "unknown",
      signed: false,
      verified: false,
      keyvault_configured: keyVaultConfigured,
      env_present: presence,
      message: "Self-test failed to run.",
    });
  }
}
