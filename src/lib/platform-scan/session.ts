/**
 * Authenticated session establishment for platform-scan.
 *
 * Some target surfaces only reveal their real behavior once you are logged in:
 * an admin journey, a write API, a gated dashboard. To exercise those, the scan
 * needs a session cookie. `establishSession` performs a username/password login
 * against the target and extracts the session cookie from the `Set-Cookie`
 * response, returning a ready-to-send `name=value` pair for a `Cookie:` request
 * header.
 *
 * Beyond's login endpoint takes `{ email, password }`, so the stored username is
 * sent as `email`. This is a credential-bearing network call against an EXTERNAL
 * target, so it degrades gracefully in every failure mode: a non-2xx response, a
 * missing/mismatched cookie, a network error, or a timeout all yield `null`. It
 * NEVER throws — a failed login simply means the authenticated checks are
 * skipped, not that the whole scan aborts.
 */

/** Default cookie name a session lives under when the caller doesn't specify. */
const DEFAULT_SESSION_COOKIE = "session";

/** Login request timeout. */
const DEFAULT_LOGIN_TIMEOUT_MS = 8000;

export interface EstablishSessionInput {
  baseUrl: string;
  loginPath: string;
  username: string;
  password: string;
  /** Name of the cookie that carries the session. Default "session". */
  sessionCookieName?: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Login request timeout. Default 8000ms. */
  timeoutMs?: number;
}

/**
 * Pull the value of a named cookie out of a list of raw `Set-Cookie` strings.
 *
 * Each Set-Cookie looks like `name=value; HttpOnly; Path=/; ...`. We take the
 * first segment (before the first `;`), split on the FIRST `=` (values can
 * themselves contain `=`, e.g. base64), and match the name case-sensitively.
 * Returns the `name=value` pair (no attributes) ready for a Cookie header, or
 * null if no Set-Cookie names the target cookie.
 */
function extractCookiePair(setCookies: string[], name: string): string | null {
  for (const raw of setCookies) {
    if (!raw) continue;
    // A single header value may carry multiple cookies joined by ", " in some
    // runtimes; getSetCookie() splits them, but be defensive for the fallback.
    for (const part of raw.split(/,(?=\s*[^;,\s]+=)/)) {
      const first = part.split(";")[0]?.trim();
      if (!first) continue;
      const eq = first.indexOf("=");
      if (eq <= 0) continue;
      const cookieName = first.slice(0, eq).trim();
      if (cookieName !== name) continue;
      const cookieValue = first.slice(eq + 1).trim();
      return `${cookieName}=${cookieValue}`;
    }
  }
  return null;
}

/**
 * Read all raw Set-Cookie strings off a Headers, robust across runtimes. In
 * Node/undici multiple Set-Cookie headers are joined into one string by
 * `get("set-cookie")`, which corrupts cookies; `getSetCookie()` returns them
 * un-joined as an array, so prefer it when available.
 */
function readSetCookies(headers: Headers): string[] {
  const viaGetter = (headers as { getSetCookie?: () => string[] }).getSetCookie?.();
  if (viaGetter && viaGetter.length > 0) return viaGetter;
  const single = headers.get("set-cookie");
  return single ? [single] : [];
}

/**
 * Log into a target platform and return its session cookie as a `name=value`
 * pair for a Cookie request header, or null on any failure.
 */
export async function establishSession(
  input: EstablishSessionInput,
): Promise<{ cookie: string } | null> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const cookieName = input.sessionCookieName ?? DEFAULT_SESSION_COOKIE;
  const timeoutMs = input.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS;
  const url = `${input.baseUrl}${input.loginPath}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: input.username, password: input.password }),
      signal: controller.signal,
      redirect: "manual",
    });

    if (res.status < 200 || res.status >= 300) return null;

    const pair = extractCookiePair(readSetCookies(res.headers), cookieName);
    return pair ? { cookie: pair } : null;
  } catch {
    // Network error, abort/timeout, or a malformed response — degrade to null.
    return null;
  } finally {
    clearTimeout(timer);
  }
}
