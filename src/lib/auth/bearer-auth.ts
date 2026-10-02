/**
 * Bearer-secret authorization for cron / service routes - the ONE helper.
 *
 * Cron and internal service routes authorize by a shared secret presented as
 * `Authorization: Bearer <secret>`. ~35 routes used to inline
 * `authorization === `Bearer ${secret}``, which is a timing-unsafe secret compare
 * (CWE-208) AND 35 copies of the same logic. This centralizes it: one timing-safe
 * check, used everywhere, so the comparison can never regress to `===` and the
 * rule lives in one place.
 */
import { timingSafeEqualStr } from "@/lib/crypto/timing-safe";

/**
 * True when the request's Authorization header presents the expected bearer
 * secret, compared in constant time. False when the secret is unset/empty (an
 * unconfigured route authorizes no one) or the header does not match.
 */
export function isAuthorizedBearer(authHeader: string | null | undefined, secret: string | undefined | null): boolean {
  if (!secret) return false;
  return timingSafeEqualStr(authHeader ?? "", `Bearer ${secret}`);
}
