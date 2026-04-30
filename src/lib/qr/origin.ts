/**
 * Resolve the absolute origin a QR code should encode.
 *
 * The QR encoder MUST receive an absolute https URL. A relative path
 * like `/q/abc1234` decodes fine on a desktop browser but a phone
 * camera has no base URL — it falls back to a Google search of the
 * literal string, which is exactly what hit production today
 * (scanning a code landed users on `google.com/search?q=/q/w4ge9r4`).
 *
 * Resolution order:
 *   1. `NEXT_PUBLIC_BASE_URL` if set (canonical)
 *   2. `VERCEL_URL` if set (Vercel always populates this on deployed
 *      builds; format is "host" without a scheme, so we prepend https)
 *   3. The request URL's own origin (works in any runtime)
 *
 * Throws if none can be derived. We prefer a loud failure over an
 * encoded-but-broken QR.
 */
export function resolvePublicOrigin(req: Request): string {
  const fromEnv = process.env.NEXT_PUBLIC_BASE_URL?.replace(/\/+$/, "");
  if (fromEnv && /^https?:\/\//i.test(fromEnv)) return fromEnv;

  const vercel = process.env.VERCEL_URL?.replace(/\/+$/, "");
  if (vercel) {
    return vercel.startsWith("http") ? vercel : `https://${vercel}`;
  }

  try {
    const u = new URL(req.url);
    return `${u.protocol}//${u.host}`;
  } catch {
    throw new Error(
      "Cannot derive public origin for QR — set NEXT_PUBLIC_BASE_URL",
    );
  }
}
