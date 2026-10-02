/**
 * The ONE timing-safe string comparison primitive.
 *
 * WHY: comparing a secret with `===` returns on the first differing byte, so the
 * comparison time leaks how many leading bytes matched - a token/HMAC/signature
 * can be recovered byte by byte over many requests (CWE-208). Before this existed,
 * ~35 route handlers compared a bearer secret with `authorization === `Bearer
 * ${secret}`` (timing-unsafe) and three separate modules each re-implemented the
 * Buffer + length-guard + timingSafeEqual dance. This is the single primitive they
 * all route through.
 *
 * Length-safe: node's timingSafeEqual THROWS on a length mismatch (and the length
 * itself is not secret), so we check lengths first and return false - still without
 * a short-circuiting byte compare on equal-length inputs.
 */
import { timingSafeEqual } from "node:crypto";

/** Constant-time equality for two UTF-8 strings. Returns false on any length
 *  mismatch or non-string input; never throws. */
export function timingSafeEqualStr(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
