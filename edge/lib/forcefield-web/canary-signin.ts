/**
 * Forcefield for the Web - canary sign-ins, the SITE side (vendored, edge-safe).
 *
 * A site plants a fake service sign-in in its decoys (mintCanarySignIn) and, in
 * its own sign-in handler, asks whether a username is one of them
 * (checkCanarySignIn). Instinct holds the registry and records the trip
 * (src/lib/forcefield/canary-login.ts, /api/forcefield/canary/*); the site
 * authenticates with the ingest token it already holds, so it needs no new
 * secret. Only usernames of the canary SHAPE are ever sent: a real username
 * never leaves the site.
 *
 * Never throws: an unreachable Instinct means "not a canary" (the sign-in goes on
 * through its normal checks) and "no bait" for the decoy.
 */
import { clientKeys } from "./observe";
import { DEFAULT_RULESET } from "./ruleset";

/** Every canary username has this shape ("svc_backup_k7q2m4"). */
export const CANARY_LOGIN_RE = /^svc_[a-z]{3,8}_[a-z2-7]{6}$/;

export function isCanaryUsername(username: unknown): username is string {
  return typeof username === "string" && CANARY_LOGIN_RE.test(username);
}

/**
 * The canary username in what was typed into a sign-in field, or null. Sign-in
 * forms often ask for an email, so a replayed canary may arrive whole
 * ("svc_backup_k7q2m4") or with a domain added ("svc_backup_k7q2m4@site.com");
 * either is the canary. Call it on the RAW field before the form's own
 * validation, which would reject the bare username.
 */
export function canaryUsernameFrom(identifier: unknown): string | null {
  if (typeof identifier !== "string") return null;
  const v = identifier.trim().toLowerCase();
  if (CANARY_LOGIN_RE.test(v)) return v;
  const at = v.indexOf("@");
  return at > 0 && CANARY_LOGIN_RE.test(v.slice(0, at)) ? v.slice(0, at) : null;
}

/** The canary endpoint on Instinct, derived like the policy URL (from the ingest URL). */
export function canaryEndpoint(kind: "mint" | "check", env: NodeJS.ProcessEnv = process.env): string | null {
  try {
    if (!env.FORCEFIELD_INGEST_URL) return null;
    return `${new URL(env.FORCEFIELD_INGEST_URL).origin}/api/forcefield/canary/${kind}`;
  } catch {
    return null;
  }
}

async function post(kind: "mint" | "check", body: Record<string, string>, env: NodeJS.ProcessEnv): Promise<Record<string, unknown> | null> {
  const url = canaryEndpoint(kind, env);
  const token = env.SITE_ANALYTICS_INGEST_TOKEN;
  if (!url || !token) return null;
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-ingest-token": token },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(1500),
    });
    return r.ok ? ((await r.json()) as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Is this sign-in attempt using a planted canary? Records the trip on Instinct. */
export async function checkCanarySignIn(
  input: { site: string; username: unknown; path?: string; fp?: string; sig?: string },
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  if (!isCanaryUsername(input.username)) return false;
  const j = await post("check", { site: input.site, username: input.username, path: input.path ?? "", fp: input.fp ?? "", sig: input.sig ?? "" }, env);
  return j?.canary === true;
}

const _minted = new Map<string, { username: string; password: string }>();
export function _resetCanaryCache(): void { _minted.clear(); }

/** The fake sign-in to plant in a decoy served to this session (cached). */
export async function mintCanarySignIn(
  input: { site: string; decoy: string; sig: string },
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ username: string; password: string } | null> {
  const key = `${input.site}|${input.decoy}|${input.sig}`;
  const hit = _minted.get(key);
  if (hit) return hit;
  const j = await post("mint", { site: input.site, decoy: input.decoy, sig: input.sig }, env);
  if (!j || typeof j.username !== "string" || typeof j.password !== "string") return null;
  const c = { username: j.username, password: j.password };
  if (_minted.size > 500) _minted.clear();
  _minted.set(key, c);
  return c;
}

/**
 * A site's sign-in route in one call: given the raw identifier field, report it
 * when it is a canary, keyed with this request's session and operator keys (the
 * same derivation the middleware uses) so the trip links to the visitor's other
 * events. Call it BEFORE the form's own validation, then carry on exactly as for
 * any other attempt: no such account exists, so it fails like a wrong password.
 * Caveat: a site whose middleware rewrites request headers gives a route a
 * different header shape, so fp can differ from the middleware's; the canary's
 * own origin (which decoy, which session) is unaffected.
 */
export async function reportSignInAttempt(
  site: string,
  req: { headers: Headers; nextUrl: { pathname: string } },
  identifier: unknown,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const username = canaryUsernameFrom(identifier);
  if (!username) return false;
  const h = req.headers;
  const { sig, fp } = clientKeys(
    { userAgent: h.get("user-agent") ?? "", country: h.get("x-vercel-ip-country") ?? "", headerNames: Array.from(h.keys()), nowMs: Date.now() },
    DEFAULT_RULESET,
  );
  return checkCanarySignIn({ site, username, path: req.nextUrl.pathname, fp, sig }, env);
}
