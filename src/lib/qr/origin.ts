/**
 * Resolve the absolute public origin a QR code should encode.
 *
 * QR codes are scanned by anonymous phones - the encoded URL MUST
 * point at the public production alias, not a per-deployment Vercel
 * URL like `wolfpack-instinct-kua7jbj5f-nhomyks-projects.vercel.app`
 * (which is gated by Vercel team auth and 401s for outside visitors).
 *
 * Resolution order, most-public first:
 *   1. `NEXT_PUBLIC_BASE_URL`            - explicit override (canonical)
 *   2. `VERCEL_PROJECT_PRODUCTION_URL`   - stable production alias
 *   3. `VERCEL_BRANCH_URL`               - stable branch alias
 *   4. `VERCEL_URL`                      - per-deployment URL (LAST resort;
 *                                          team-auth-gated, do not share)
 *   5. The request URL's own origin      - local dev / unit tests
 *
 * Throws if none can be derived. We prefer a loud failure over an
 * encoded-but-broken QR.
 */
export function resolvePublicOrigin(req: Request): string {
  // Branded QR redirect host (QR-only) so the scan preview shows an on-brand
  // domain (e.g. go.ogiam.com) without rebranding the whole app's base URL.
  const qrOrigin = process.env.QR_PUBLIC_ORIGIN?.replace(/\/+$/, "");
  if (qrOrigin && /^https?:\/\//i.test(qrOrigin)) return qrOrigin;

  const fromEnv = process.env.NEXT_PUBLIC_BASE_URL?.replace(/\/+$/, "");
  if (fromEnv && /^https?:\/\//i.test(fromEnv)) return fromEnv;

  const candidates = [
    process.env.VERCEL_PROJECT_PRODUCTION_URL,
    process.env.VERCEL_BRANCH_URL,
    process.env.VERCEL_URL,
  ];
  for (const raw of candidates) {
    const v = raw?.replace(/\/+$/, "");
    if (!v) continue;
    return v.startsWith("http") ? v : `https://${v}`;
  }

  try {
    const u = new URL(req.url);
    return `${u.protocol}//${u.host}`;
  } catch {
    throw new Error(
      "Cannot derive public origin for QR - set NEXT_PUBLIC_BASE_URL",
    );
  }
}

/**
 * Resolve the origin for SERVER-SIDE self-calls (one API route calling
 * another so it inherits that route's auth + capability checks).
 *
 * Unlike {@link resolvePublicOrigin}, this MUST NOT derive the origin
 * from the incoming request. The request's Host header is attacker-
 * controlled, and these self-calls forward the caller's `Authorization`
 * bearer - trusting the request origin lets an attacker set
 * `Host: evil.example` and exfiltrate the bearer token (SSRF /
 * request-forgery, CWE-918). We only trust server-configured env, and
 * fall back to a fixed localhost default for dev. Throws if a non-local
 * runtime has no trusted origin configured rather than calling out to
 * an untrusted host.
 */
export function resolveInternalOrigin(): string {
  const fromEnv = process.env.NEXT_PUBLIC_BASE_URL?.replace(/\/+$/, "");
  if (fromEnv && /^https?:\/\//i.test(fromEnv)) return fromEnv;

  const candidates = [
    process.env.VERCEL_PROJECT_PRODUCTION_URL,
    process.env.VERCEL_BRANCH_URL,
    process.env.VERCEL_URL,
  ];
  for (const raw of candidates) {
    const v = raw?.replace(/\/+$/, "");
    if (!v) continue;
    return v.startsWith("http") ? v : `https://${v}`;
  }

  // Dev / test only: no deployment env present.
  if (process.env.NODE_ENV !== "production") return "http://localhost:3000";

  throw new Error(
    "Cannot derive internal origin for server self-call - set NEXT_PUBLIC_BASE_URL",
  );
}
